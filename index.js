import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const elevenlabs = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY
})

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

const PORT = 3001

app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`)
})