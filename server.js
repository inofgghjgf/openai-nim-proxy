const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// NVIDIA NIM API Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';

// DeepSeek 3.2 model mapping
const MODEL_MAPPING = {
    'gpt-3.5-turbo': 'deepseek/deepseek-chat',
    'gpt-4': 'deepseek/deepseek-chat',
    'gpt-4-turbo': 'deepseek/deepseek-chat',
    'deepseek-chat': 'deepseek/deepseek-chat',
    'deepseek-3.2': 'deepseek/deepseek-chat'
};

// Function to convert OpenAI format to NVIDIA NIM format
function convertToNvidiaFormat(openaiRequest) {
    const model = MODEL_MAPPING[openaiRequest.model] || 'deepseek/deepseek-chat';
    
    // Convert messages to NVIDIA format
    const messages = openaiRequest.messages.map(msg => ({
        role: msg.role,
        content: msg.content
    }));

    return {
        model: model,
        messages: messages,
        temperature: openaiRequest.temperature || 0.7,
        max_tokens: openaiRequest.max_tokens || 2048,
        top_p: openaiRequest.top_p || 1.0,
        frequency_penalty: openaiRequest.frequency_penalty || 0,
        presence_penalty: openaiRequest.presence_penalty || 0,
        stream: openaiRequest.stream || false
    };
}

// Function to convert NVIDIA response to OpenAI format
function convertToOpenAIFormat(nvidiaResponse, model) {
    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: nvidiaResponse.choices[0].message.content
            },
            finish_reason: nvidiaResponse.choices[0].finish_reason || 'stop'
        }],
        usage: {
            prompt_tokens: nvidiaResponse.usage?.prompt_tokens || 0,
            completion_tokens: nvidiaResponse.usage?.completion_tokens || 0,
            total_tokens: nvidiaResponse.usage?.total_tokens || 0
        }
    };
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Models endpoint (required for Janitor AI compatibility)
app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
            {
                id: 'deepseek-3.2',
                object: 'model',
                created: 1677610602,
                owned_by: 'deepseek',
                permission: [],
                root: 'deepseek-3.2',
                parent: null
            },
            {
                id: 'gpt-3.5-turbo',
                object: 'model',
                created: 1677610602,
                owned_by: 'openai',
                permission: [],
                root: 'gpt-3.5-turbo',
                parent: null
            }
        ]
    });
});

// Main chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
    try {
        console.log('Received request:', JSON.stringify(req.body, null, 2));
        
        if (!NVIDIA_API_KEY) {
            return res.status(500).json({
                error: {
                    message: 'NVIDIA API key not configured',
                    type: 'invalid_configuration',
                    code: 'missing_api_key'
                }
            });
        }

        // Convert OpenAI format request to NVIDIA format
        const nvidiaRequest = convertToNvidiaFormat(req.body);
        console.log('Converted to NVIDIA format:', JSON.stringify(nvidiaRequest, null, 2));

        // Handle streaming
        if (nvidiaRequest.stream) {
            return handleStreamingRequest(req, res, nvidiaRequest);
        }

        // Make request to NVIDIA NIM API
        const response = await axios.post(
            `${NVIDIA_BASE_URL}/chat/completions`,
            nvidiaRequest,
            {
                headers: {
                    'Authorization': `Bearer ${NVIDIA_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 120000 // 2 minutes timeout
            }
        );

        console.log('NVIDIA response:', JSON.stringify(response.data, null, 2));

        // Convert NVIDIA response back to OpenAI format
        const openaiResponse = convertToOpenAIFormat(response.data, req.body.model);
        
        res.json(openaiResponse);

    } catch (error) {
        console.error('Error:', error.message);
        console.error('Error details:', error.response?.data);

        let errorResponse = {
            error: {
                message: 'Internal server error',
                type: 'internal_error',
                code: 'server_error'
            }
        };

        if (error.response) {
            // NVIDIA API error
            errorResponse.error.message = error.response.data?.error?.message || 'API request failed';
            errorResponse.error.type = 'api_error';
            errorResponse.error.code = error.response.status.toString();
        } else if (error.code === 'ECONNREFUSED') {
            errorResponse.error.message = 'Cannot connect to NVIDIA API';
            errorResponse.error.type = 'connection_error';
        }

        res.status(error.response?.status || 500).json(errorResponse);
    }
});

// Handle streaming requests
async function handleStreamingRequest(req, res, nvidiaRequest) {
    try {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const response = await axios.post(
            `${NVIDIA_BASE_URL}/chat/completions`,
            nvidiaRequest,
            {
                headers: {
                    'Authorization': `Bearer ${NVIDIA_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                responseType: 'stream',
                timeout: 120000
            }
        );

        response.data.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    
                    if (data === '[DONE]') {
                        res.write('data: [DONE]\n\n');
                        return;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        // Convert to OpenAI streaming format
                        const openaiChunk = {
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: req.body.model,
                            choices: [{
                                index: 0,
                                delta: parsed.choices[0].delta,
                                finish_reason: parsed.choices[0].finish_reason
                            }]
                        };
                        
                        res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                    } catch (e) {
                        console.error('Error parsing streaming chunk:', e);
                    }
                }
            }
        });

        response.data.on('end', () => {
            res.write('data: [DONE]\n\n');
            res.end();
        });

        response.data.on('error', (error) => {
            console.error('Streaming error:', error);
            res.end();
        });

    } catch (error) {
        console.error('Streaming request error:', error);
        res.status(500).json({
            error: {
                message: 'Streaming request failed',
                type: 'stream_error'
            }
        });
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: {
            message: 'Internal server error',
            type: 'internal_error'
        }
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 NVIDIA NIM Proxy Server running on port ${PORT}`);
    console.log(`📡 API endpoint: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`🔗 Models endpoint: http://localhost:${PORT}/v1/models`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
