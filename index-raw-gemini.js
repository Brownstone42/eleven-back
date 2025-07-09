import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fetch from 'node-fetch'

import { SpeechClient } from '@google-cloud/speech'
import { WebSocketServer } from 'ws'
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'

dotenv.config()

const googleSpeechClient = new SpeechClient()
console.log('Google Cloud Speech-to-Text client initialized.')

const PORT = 3001

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

const server = app.listen(PORT, () => {
    console.log(`Backend HTTP server running on http://localhost:${PORT}`);
})

const wss = new WebSocketServer({ server })

wss.on('connection', ws => {
    console.log('Client connected via WebSocket.')

    let recognizeStream = null

    ws.on('message', message => {
        if (typeof message === 'object' && message instanceof Buffer) {

            if (!recognizeStream) {
                const request = {
                    config: {
                        encoding: 'LINEAR16',
                        sampleRateHertz: 16000,
                        languageCode: 'th-TH',
                        interimResults: true,
                        enableAutomaticPunctuation: true,
                        enableVoiceActivityDetection: true,
                    },
                    interimResults: true
                }

                recognizeStream = googleSpeechClient.streamingRecognize(request).on('error', (error) => {
                    console.error('Google STT Streaming Error:', error)
                    ws.send(JSON.stringify({ error: `STT streaming error: ${error.message}` }))
                    ws.close()
                }).on('data', async (data) => {
                    if (data.results && data.results.length > 0) {
                        const result = data.results[0]

                        if (result.alternatives && result.alternatives.length > 0) {
                            const transcript = result.alternatives[0].transcript
                            console.log('STT Interim/Final Result:', transcript, 'Is Final:', result.isFinal)

                            ws.send(JSON.stringify({ transcribedText: transcript, isFinal: result.isFinal }))

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
                                    console.log('Backend: Starting Azure TTS...')

                                    const speechKey = process.env.AZURE_SPEECH_KEY
                                    const speechRegion = process.env.AZURE_SPEECH_REGION
                                    const voiceName = process.env.AZURE_TTS_VOICE_NAME || "th-TH-AcharaNeural"

                                    if (!speechKey || !speechRegion) {
                                        throw new Error('Azure Speech Key or Region not configured in environment variables.')
                                    }

                                    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion)
                                    speechConfig.speechSynthesisVoiceName = voiceName
                                    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3

                                    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, undefined)
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

                                    ws.send(JSON.stringify({ aiAudioBase64: aiAudioBase64 }))
                                } catch (aiProcessingError) {
                                    console.error('Backend: Error in AI response generation or TTS:', aiProcessingError)
                                    ws.send(JSON.stringify({ error: `AI/TTS error: ${aiProcessingError.message}` }))
                                }
                            }
                        }
                    }
                })

                console.log('Google STT streaming recognition started.')
            }

            recognizeStream.write(message)
        } else {
            console.log('Backend: Received non-audio message from client WebSocket:', message.toString())
        }
    })

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket. Ending STT stream.')

        if (recognizeStream) {
            recognizeStream.end()
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