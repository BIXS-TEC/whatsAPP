const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');
const PQueue = require('p-queue');

const app = express();

// Configurando CORS para permitir requisições de qualquer origem
app.use(cors());
app.use(express.json());

let sessoes = {}; // Armazena as sessões ativas
let estadosSessoes = {}; // Armazena o estado de cada sessão

const queue = new PQueue({ concurrency: 2 }); // Limita a criação de 2 sessões simultâneas

function criarSessao(nomeSessao, enviarQRCode, atualizarStatus) {
    if (sessoes[nomeSessao]) {
        console.log(`Sessão ${nomeSessao} já existe.`);
        return sessoes[nomeSessao];
    }

    estadosSessoes[nomeSessao] = { isManualLogout: false, qrCodeEnviado: false };

    console.log(`Criando sessão ${nomeSessao}...`);
    const sessionPath = `./tokens/${nomeSessao}`;
    const sessao = wppconnect.create({
        session: nomeSessao,
        catchQR: (qrCode, session) => {
            console.log(`QR Code gerado para a sessão ${session}.`);
            if (!estadosSessoes[session]?.qrCodeEnviado) {
                estadosSessoes[session].qrCodeEnviado = true;
                enviarQRCode(qrCode);
                setTimeout(() => {
                    estadosSessoes[session].qrCodeEnviado = false;
                }, 60000); // QR Code expira após 60 segundos
            }
        },
        onQRCodeExpired: (session) => {
            if (!estadosSessoes[session]?.isManualLogout) {
                console.log(`QR Code expirado para a sessão ${session}. Gerando outro...`);
                criarSessao(session, enviarQRCode, atualizarStatus);
            }
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

    sessao.then((client) => {
        console.log(`Sessão ${nomeSessao} criada com sucesso.`);
        client.onStateChange((state) => {
            console.log(`Estado da sessão ${nomeSessao}: ${state}`);
            if (state === 'CONNECTED') {
                atualizarStatus('Conectado com sucesso');
            } else if (state === 'DISCONNECTED') {
                if (!estadosSessoes[nomeSessao]?.isManualLogout) {
                    console.log(`Sessão ${nomeSessao} desconectada. Tentando reconectar...`);
                    criarSessao(nomeSessao, enviarQRCode, atualizarStatus);
                } else {
                    console.log(`Sessão ${nomeSessao} foi desconectada manualmente.`);
                }
            }
        });
    }).catch((error) => {
        console.error(`Erro ao criar sessão ${nomeSessao}:`, error);
        delete sessoes[nomeSessao];
        delete estadosSessoes[nomeSessao];
    });

    return sessao;
}

// Função com fila para controlar a criação de sessões
function criarSessaoComFila(nomeSessao, enviarQRCode, atualizarStatus) {
    return queue.add(() => criarSessao(nomeSessao, enviarQRCode, atualizarStatus));
}

// Rota para desconectar manualmente uma sessão
app.get('/desconectar/:nomeSessao', async (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (sessoes[nomeSessao]) {
        try {
            estadosSessoes[nomeSessao].isManualLogout = true;
            const client = await sessoes[nomeSessao];
            await client.logout();

            delete sessoes[nomeSessao];
            delete estadosSessoes[nomeSessao];

            console.log(`Sessão ${nomeSessao} encerrada com sucesso.`);
            return res.status(200).json({ status: 'Sessão encerrada com sucesso.' });
        } catch (error) {
            console.error(`Erro ao encerrar sessão ${nomeSessao}:`, error);
            return res.status(500).json({ error: 'Erro ao encerrar a sessão.' });
        }
    } else {
        return res.status(404).json({ error: 'Sessão não encontrada.' });
    }
});

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
app.get('/gerar-qrcode/:nomeSessao', (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (sessoes[nomeSessao]) {
        sessoes[nomeSessao].then((client) => {
            client.getConnectionState().then((state) => {
                if (state === 'CONNECTED') {
                    return res.status(200).json({ status: 'Sessão já conectada' });
                } else {
                    criarSessaoComFila(
                        nomeSessao,
                        (qrCode) => res.status(200).json({ status: 'Aguardando conexão', qrcode: qrCode }),
                        (status) => res.status(200).json({ status })
                    );
                }
            }).catch((error) => {
                console.error(`Erro ao verificar estado da sessão ${nomeSessao}:`, error);
                res.status(500).json({ error: 'Erro ao verificar estado da sessão.' });
            });
        });
    } else {
        criarSessaoComFila(
            nomeSessao,
            (qrCode) => res.status(200).json({ status: 'Aguardando conexão', qrcode: qrCode }),
            (status) => res.status(200).json({ status })
        );
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
app.listen(3000, () => {
    console.log('Servidor rodando na porta 3000');
});