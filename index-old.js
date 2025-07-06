import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fetch from 'node-fetch'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { SpeechClient } from '@google-cloud/speech'
import { WebSocketServer } from 'ws'
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'

dotenv.config()

const googleSpeechClient = new SpeechClient()
console.log('Google Cloud Speech-to-Text client initialized.')

const elevenlabs = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY
})

const PORT = 3001

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

app.get('/api/get-signed-url', async (req, res) => {
    try {
        const result = await elevenlabs.conversationalAi.conversations.getSignedUrl({
            agentId: process.env.AGENT_ID,
        })
        console.log('RAW RESPONSE:', result)
        res.json(result)
    } catch (err) {
        console.error('Failed to get signed URL:', err.message)
        res.status(500).json({ error: 'Failed to get signed URL' })
    }
})

const server = app.listen(PORT, () => {
    console.log(`Backend HTTP server running on http://localhost:${PORT}`);
})

const wss = new WebSocketServer({ server })

wss.on('connection', ws => {
    console.log('Client connected via WebSocket.')

    let recognizeStream = null

    ws.on('message', message => {
        if (typeof message === 'object' && message instanceof Buffer) {

            //console.log('Backend: Received audio chunk from frontend. Size:', message.length, 'bytes')

            if (!recognizeStream) {
                const request = {
                    config: {
                        encoding: 'LINEAR16', // Expecting raw 16-bit PCM from frontend
                        sampleRateHertz: 16000, // IMPORTANT: Match frontend's actual sample rate
                        languageCode: 'th-TH',
                        // Add interim results and voice activity detection settings
                        interimResults: true, // Get partial results as user speaks
                        enableAutomaticPunctuation: true, // Automatically add punctuation
                        enableVoiceActivityDetection: true, // Enable VAD for auto-stopping
                    },
                    interimResults: true, // Also set here for the stream
                }

                recognizeStream = googleSpeechClient.streamingRecognize(request)
                    .on('error', (error) => {
                        console.error('Google STT Streaming Error:', error)
                        ws.send(JSON.stringify({ error: `STT streaming error: ${error.message}` }))
                        ws.close()
                    })
                    .on('data', async (data) => {

                        //console.log('Backend: Received data from Google STT:', JSON.stringify(data, null, 2))

                        if (data.results && data.results.length > 0) {
                            const result = data.results[0]
                            if (result.alternatives && result.alternatives.length > 0) {
                                const transcript = result.alternatives[0].transcript
                                console.log('STT Interim/Final Result:', transcript, 'Is Final:', result.isFinal)

                                ws.send(JSON.stringify({ transcribedText: transcript, isFinal: result.isFinal }))

                                // If it's a final result and VAD is enabled, Google might close the stream
                                // or we might want to manage utterance boundaries.
                                // For now, we'll let Google manage the stream closure based on VAD/timeout.
                                if (result.isFinal) {
                                    console.log('Backend: Final STT result received. Calling Gemini...')

                                    try {
                                        const promptForGemini = `คุณคือผู้ช่วยที่ตอบคำถามอย่างรวดเร็วและกระชับที่สุด ตอบกลับไม่เกิน 2 ประโยค และห้ามใช้ Emoji หรือสัญลักษณ์พิเศษใดๆ\n\nคำถาม: ${transcript}`
                                        let chatHistory = [{ role: "user", parts: [{ text: promptForGemini }] }]

                                        const geminiPayload = { contents: chatHistory }
                                        const geminiApiKey = process.env.GEMINI_API_KEY
                                        const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`

                                        const geminiResponse = await fetch(geminiApiUrl, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(geminiPayload)
                                        })

                                        if (!geminiResponse.ok) {
                                            const errorData = await geminiResponse.json()
                                            throw new Error(`Gemini API error: ${geminiResponse.status} - ${errorData.error.message}`)
                                        }

                                        const geminiResult = await geminiResponse.json()
                                        let aiText = "ฉันไม่เข้าใจค่ะ กรุณาลองใหม่อีกครั้ง."

                                        if (geminiResult.candidates && geminiResult.candidates.length > 0 &&
                                            geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts &&
                                            geminiResult.candidates[0].content.parts.length > 0) {
                                            aiText = geminiResult.candidates[0].content.parts[0].text
                                        } else {
                                            console.warn('Backend: Gemini returned an unexpected response structure.')
                                        }

                                        console.log('Backend: AI Generated Text:', aiText)

                                        // For now, send AI's text response back to frontend
                                        // In the next step, we'll convert this to speech
                                        //ws.send(JSON.stringify({ aiResponseText: aiText }))

                                        // --- NEW: Text-to-Speech (Microsoft Azure Cognitive Services Speech) ---
                                        console.log('Backend: Starting Azure TTS...')

                                        const speechKey = process.env.AZURE_SPEECH_KEY
                                        const speechRegion = process.env.AZURE_SPEECH_REGION
                                        const voiceName = process.env.AZURE_TTS_VOICE_NAME || "th-TH-AcharaNeural"

                                        if (!speechKey || !speechRegion) {
                                            throw new Error('Azure Speech Key or Region not configured in environment variables.');
                                        }

                                        const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion)
                                        speechConfig.speechSynthesisVoiceName = voiceName
                                        // Output format for audio, e.g., mp3, opus. Needs to be playable by browser.
                                        speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3 // A common MP3 format

                                        const synthesizer = new sdk.SpeechSynthesizer(speechConfig, undefined) // undefined for default audio output

                                        const azureAudioBuffer = await new Promise((resolve, reject) => {
                                            synthesizer.speakTextAsync(
                                                aiText,
                                                result => {
                                                    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                                                        resolve(Buffer.from(result.audioData))
                                                    } else {
                                                        const cancellationDetails = sdk.SpeechSynthesisCancellationDetails.fromResult(result)
                                                        reject(new Error(`Azure TTS canceled: ${cancellationDetails.reason}. Error details: ${cancellationDetails.errorDetails}`))
                                                    }
                                                },
                                                error => {
                                                    synthesizer.close()
                                                    reject(new Error(`Azure TTS error: ${error}`))
                                                }
                                            )
                                        })

                                        const aiAudioBase64 = azureAudioBuffer.toString('base64')
                                        console.log('Backend: Azure TTS completed. Sending audio to frontend.')

                                        // Send AI's audio response (base64) back to frontend
                                        ws.send(JSON.stringify({ aiAudioBase64: aiAudioBase64 }))
                                    } catch (aiProcessingError) {
                                        console.error('Backend: Error in AI response generation or TTS:', aiProcessingError);
                                        ws.send(JSON.stringify({ error: `AI/TTS error: ${aiProcessingError.message}` }));
                                    }
                                }
                            }
                        }
                    })

                console.log('Google STT streaming recognition started.')
            }

            recognizeStream.write(message)
            //console.log('Backend: Wrote audio chunk to STT stream.')
        } else {
            console.log('Backend: Received non-audio message from client WebSocket:', message.toString())
        }
    })

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket. Ending STT stream.')
        if (recognizeStream) {
            recognizeStream.end() // End the Google STT stream when client disconnects
            recognizeStream = null
        }
    })

    ws.on('error', error => {
        console.error('WebSocket error:', error)
        if (recognizeStream) {
            recognizeStream.end()
            recognizeStream = null
        }
    })
})

console.log('WebSocket server initialized.')