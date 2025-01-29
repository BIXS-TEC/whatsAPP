const http = require('http'); // Mova esta linha para o início do arquivo
const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');
const PQueue = require('p-queue').default; // Importação correta
const queue = new PQueue({ concurrency: 1 }); // Configuração do PQueue

const app = express();
const server = http.createServer(app); // Agora esta linha está correta

const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

// Configurando CORS para permitir requisições de qualquer origem
app.use(cors());
app.use(express.json());

let logoutTimers = {}; 
let sessoes = {}; // Armazena as sessões ativas
let estadosSessoes = {}; // Armazena o estado de cada sessão
const locks = {}; 

let sockets = {}; // Armazena os sockets por nome de sessão

wss.on('connection', (ws, req) => {
    const nomeSessao = req.url.replace('/', ''); // Extrai o nome da sessão da URL
    sockets[nomeSessao] = ws;

    ws.on('close', () => {
        delete sockets[nomeSessao];
    });
});

function notificarSessaoConectada(nomeSessao) {
    if (sockets[nomeSessao]) {
        sockets[nomeSessao].send(JSON.stringify({ status: 'Conectado' }));
    }
}

function criarSessaoComControle(nomeSessao, enviarQRCode, atualizarStatus) {
    if (locks[nomeSessao]) {
        console.log(`Sessão ${nomeSessao} já está sendo recriada.`);
        return;
    }

    // Verifica se a recriação foi bloqueada por logout manual
    if (estadosSessoes[nomeSessao]?.isManualLogout || logoutTimers[nomeSessao]) {
        console.log(`Recriação da sessão ${nomeSessao} bloqueada devido ao logout manual.`);
        return;
    }

    locks[nomeSessao] = true; // Ativa o lock
    criarSessaoComFila(nomeSessao, enviarQRCode, atualizarStatus).finally(() => {
        delete locks[nomeSessao]; // Libera o lock após a recriação
    });
}

const criarSessaoComFila = (nomeSessao, enviarQRCode, atualizarStatus) => {
    return queue.add(() =>
        new Promise((resolve, reject) => {
            try {
                const sessao = criarSessao(nomeSessao, enviarQRCode, atualizarStatus);
                resolve(sessao);
            } catch (error) {
                reject(error);
            }
        })
    );
};
function criarSessao(nomeSessao, enviarQRCode, atualizarStatus) {
    if (sessoes[nomeSessao]) {
        console.log(`Sessão ${nomeSessao} já existe.`);
        return sessoes[nomeSessao];
    }

    estadosSessoes[nomeSessao] = { isManualLogout: false, qrCode: null };

    console.log(`Criando sessão ${nomeSessao}...`);
    const sessionPath = `./tokens/${nomeSessao}`;
    const sessao = wppconnect.create({
        session: nomeSessao,
        catchQR: (qrCode, session) => {
            console.log(`QR Code gerado para a sessão ${session}.`);
            estadosSessoes[session] = estadosSessoes[session] || {};
            estadosSessoes[session].qrCode = qrCode; // Atualiza o QR Code
            if (enviarQRCode) {
                enviarQRCode(qrCode);
            }
        },
        onQRCodeExpired: (session) => {
            console.log(`QR Code expirado para a sessão ${session}.`);
        
            // Verifica se o logout foi manual
            if (estadosSessoes[session]?.isManualLogout || logoutTimers[session]) {
                console.log(`Sessão ${session} não será recriada devido ao logout manual.`);
                return;
            }
        
            estadosSessoes[session].qrCode = null; // Limpa o QR Code
            criarSessaoComControle(session, enviarQRCode, atualizarStatus);
        },  
        puppeteerOptions: {
            userDataDir: sessionPath,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
            ],
        },
    });

    sessoes[nomeSessao] = sessao;

    return sessao
        .then((client) => {
            console.log(`Sessão ${nomeSessao} criada com sucesso.`);
            client.onStateChange((state) => {
                console.log(`Estado da sessão ${nomeSessao}: ${state}`);
                if (state === 'CONNECTED') {
                    atualizarStatus('Conectado com sucesso');
                    notificarSessaoConectada(nomeSessao); // Notifica o front-end
                } else if (state === 'DISCONNECTED') {
                    criarSessao(nomeSessao, enviarQRCode, atualizarStatus);
                }
            });

            return 'Conectado';
        })
        .catch((error) => {
            console.error(`Erro ao criar sessão ${nomeSessao}:`, error);
            throw error;
        });
}


// Rota para verificar o status de uma sessão
app.get('/status-sessao/:nomeSessao', async (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (!sessoes[nomeSessao]) {
        return res.status(404).json({ status: 'Sessão não encontrada' });
    }

    try {
        const client = await sessoes[nomeSessao];
        const state = await client.getConnectionState();
        return res.status(200).json({ status: state });
    } catch (error) {
        console.error(`Erro ao verificar estado da sessão ${nomeSessao}:`, error);
        return res.status(500).json({ error: 'Erro ao verificar estado da sessão.' });
    }
});

// Rota para gerar ou verificar o QR Code
app.get('/gerar-qrcode/:nomeSessao', async (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    // Se a sessão já existe e está conectada, retorna status de sucesso
    if (sessoes[nomeSessao]) {
        try {
            const client = await sessoes[nomeSessao];
            const state = await client.getConnectionState();

            if (state === 'CONNECTED') {
                console.log(`Sessão ${nomeSessao} já conectada.`);
                return res.status(200).json({ status: 'Conectado' });
            }
        } catch (error) {
            console.error(`Erro ao verificar estado da sessão ${nomeSessao}:`, error);
        }
    }

    // Se a sessão existe mas precisa de um QR Code, retorna ele
    if (estadosSessoes[nomeSessao]?.qrCode) {
        console.log(`QR Code encontrado para a sessão ${nomeSessao}.`);
        return res.status(200).json({ status: 'Aguardando conexão', qrcode: estadosSessoes[nomeSessao].qrCode });
    }

    // Se a sessão não existe, criar e esperar pelo QR Code
    try {
        const qrCode = await new Promise((resolve, reject) => {
            let timeout = setTimeout(() => {
                reject(new Error('Tempo limite para gerar QR Code expirado.'));
            }, 15000); // Tempo máximo de espera de 15s

            criarSessaoComFila(
                nomeSessao,
                (qr) => {
                    clearTimeout(timeout);
                    resolve(qr);
                },
                (status) => console.log(`Status atualizado: ${status}`)
            );
        });

        return res.status(200).json({ status: 'Aguardando conexão', qrcode: qrCode });
    } catch (error) {
        console.error(`Erro ao gerar QR Code para a sessão ${nomeSessao}:`, error);
        return res.status(500).json({ error: 'Erro ao gerar QR Code.' });
    }
});

// Rota para desconectar manualmente uma sessão
app.post('/desconectar/:nomeSessao', async (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (!sessoes[nomeSessao]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        estadosSessoes[nomeSessao] = estadosSessoes[nomeSessao] || {};
        estadosSessoes[nomeSessao].isManualLogout = true; // Marca que o logout foi manual

        const client = await sessoes[nomeSessao];
        await client.logout();

        console.log(`Sessão ${nomeSessao} desconectada com sucesso.`);

        // Remove completamente a sessão para evitar reconexão automática
        delete sessoes[nomeSessao];
        delete estadosSessoes[nomeSessao];

        return res.status(200).json({ status: 'Sessão desconectada e removida com sucesso' });
    } catch (error) {
        console.error(`Erro ao desconectar sessão ${nomeSessao}:`, error);
        return res.status(500).json({ error: 'Erro ao desconectar sessão' });
    }
});

app.post('/enviar-ingresso', async (req, res) => {
    const { nomeSessao, numero, urlImagem, textoIngresso, textoConvite, textoConfirmacao } = req.body;

    if (!sessoes[nomeSessao]) {
        return res.status(404).json({ status: 'Sessão não encontrada' });
    }

    try {
        const client = await sessoes[nomeSessao];

        // Envia a mensagem com a imagem e o texto "Este é seu ingresso"
        await client.sendFile(
            `${numero}@c.us`,     // Número do destinatário com código do país
            urlImagem,            // URL da imagem
            'ingresso.jpg',       // Nome do arquivo
            textoIngresso         // Texto junto com a imagem
        );

        // Envia a mensagem do convite
        await client.sendText(`${numero}@c.us`, textoConvite);

        // Envia a mensagem de confirmação de presença com links
        await client.sendText(
            `${numero}@c.us`,
            `${textoConfirmacao}`
        );

        return res.status(200).json({ status: 'Mensagens enviadas com sucesso' });
    } catch (error) {
        console.error(`Erro ao enviar mensagens: ${error.message}`);
        return res.status(500).json({ status: 'Erro ao enviar mensagens', error: error.message });
    }
});

app.post('/enviar-voucher', async (req, res) => {
    const { nomeSessao, numero, urlImagem, textovoucher, mensagem} = req.body;

    if (!sessoes[nomeSessao]) {
        return res.status(404).json({ status: 'Sessão não encontrada' });
    }

    try {
        const client = await sessoes[nomeSessao];

        // Envia a mensagem com a imagem e o texto "Este é seu ingresso"
        await client.sendFile(
            `${numero}@c.us`,     // Número do destinatário com código do país
            urlImagem,            // URL da imagem
            'voucher.png',       // Nome do arquivo
            textovoucher        // Texto junto com a imagem
        );

        // Envia a mensagem do convite
        await client.sendText(`${numero}@c.us`, mensagem);

        return res.status(200).json({ status: 'Mensagens enviadas com sucesso' });
    } catch (error) {
        console.error(`Erro ao enviar mensagens: ${error.message}`);
        return res.status(500).json({ status: 'Erro ao enviar mensagens', error: error.message });
    }
});

// Inicializa o servidor
server.listen(3000, () => console.log('Servidor iniciado na porta 3000'));