const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');
const PQueue = require('p-queue').default; // Importação correta
const queue = new PQueue({ concurrency: 1 });// Configuração do PQueue

const app = express();

// Configurando CORS para permitir requisições de qualquer origem
app.use(cors());
app.use(express.json());

let sessoes = {}; // Armazena as sessões ativas
let estadosSessoes = {}; // Armazena o estado de cada sessão
const locks = {}; 
function criarSessaoComControle(nomeSessao, enviarQRCode, atualizarStatus) {
    if (locks[nomeSessao]) {
        console.log(`Sessão ${nomeSessao} já está sendo recriada.`);
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
            estadosSessoes[session].qrCode = null; // Limpa o QR Code
            if (!estadosSessoes[session]?.isManualLogout) {
                criarSessaoComControle(session, enviarQRCode, atualizarStatus);
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

    sessao
        .then((client) => {
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
        })
        .catch((error) => {
            console.error(`Erro ao criar sessão ${nomeSessao}:`, error);
            delete sessoes[nomeSessao];
            delete estadosSessoes[nomeSessao];
        });

    return sessao;
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
app.get('/gerar-qrcode/:nomeSessao', async (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    // Verifica se a sessão já existe
    if (sessoes[nomeSessao]) {
        const estado = estadosSessoes[nomeSessao];
        if (estado.qrCode) {
            console.log(`QR Code encontrado para a sessão ${nomeSessao}.`);
            return res.status(200).json({ status: 'Aguardando conexão', qrcode: estado.qrCode });
        } else {
            console.log(`QR Code expirado ou não gerado para a sessão ${nomeSessao}.`);
        }
    }

    try {
        // Cria uma nova sessão na fila e espera pelo QR Code
        const qrCode = await new Promise((resolve, reject) => {
            criarSessaoComFila(
                nomeSessao,
                (qrCode) => resolve(qrCode),
                (status) => console.log(`Status atualizado: ${status}`)
            );
        });

        // Retorna o QR Code gerado
        res.status(200).json({ status: 'Aguardando conexão', qrcode: qrCode });
    } catch (error) {
        console.error(`Erro ao gerar QR Code para a sessão ${nomeSessao}:`, error);
        res.status(500).json({ error: 'Erro ao gerar QR Code.' });
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