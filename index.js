const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();

// Configurando CORS para permitir requisições de qualquer origem
app.use(cors());
app.use(express.json());

let sessoes = {};
let estadosSessoes={};
app.use(express.json());


function criarSessao(nomeSessao, enviarQRCode, atualizarStatus) {
    if (sessoes[nomeSessao]) {
        console.log(`Sessão ${nomeSessao} já existe.`);
        // Verifica se a sessão já está em execução
        return sessoes[nomeSessao];
    }

    // Inicializa o estado da sessão com o flag de logout manual
    estadosSessoes[nomeSessao] = { isManualLogout: false };

    console.log(`Criando sessão ${nomeSessao}...`);

    const sessao = wppconnect.create({
        session: nomeSessao,
        catchQR: (qrCode, session) => {
            console.log(`QR Code gerado para a sessão ${session}.`);
            enviarQRCode(qrCode);
        },
        onQRCodeExpired: (session) => {
            if (!estadosSessoes[session]?.isManualLogout) {
                console.log(`QR Code expirado para a sessão ${session}. Gerando outro...`);
                criarSessao(session, enviarQRCode, atualizarStatus);
            }
        },
        puppeteerOptions: {
            userDataDir: `tokens/${nomeSessao}`
        }
    });

    sessoes[nomeSessao] = sessao;

    sessao.then((client) => {
        console.log(`Sessão ${nomeSessao} criada com sucesso.`);
        client.onStateChange((state) => {
            console.log(`Estado da sessão ${nomeSessao}: ${state}`);
            if (state === 'CONNECTED') {
                atualizarStatus('Conectado com sucesso');
            } else if (state === 'DISCONNECTED') {
                // Verifique se a desconexão foi manual antes de tentar reconectar
                if (!estadosSessoes[nomeSessao]?.isManualLogout) {
                    console.log(`Sessão ${nomeSessao} desconectada. Tentando reconectar...`);
                    criarSessao(nomeSessao, enviarQRCode, atualizarStatus);
                } else {
                    console.log(`Sessão ${nomeSessao} foi desconectada manualmente. Não tentando reconectar.`);
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

// Função para encerrar a sessão manualmente
// Função para encerrar a sessão manualmente
app.get('/desconectar/:nomeSessao', async (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (sessoes[nomeSessao]) {
        try {
            // Marca o logout manual para evitar reconexão e geração do QR Code
            estadosSessoes[nomeSessao].isManualLogout = true;

            const client = await sessoes[nomeSessao];
            await client.logout();  // Desconecta a sessão

            // Exclui a sessão após o logout
            delete sessoes[nomeSessao];
            delete estadosSessoes[nomeSessao];

            console.log(`Sessão ${nomeSessao} encerrada com sucesso.`);
            return res.status(200).json({ status: 'Sessão encerrada com sucesso.' });
        } catch (error) {
            console.error(`Erro ao encerrar sessão ${nomeSessao}:`, error);
            return res.status(500).json({ error: 'Erro ao encerrar a sessão.' });
        }
    } else {
        console.log(`Tentativa de encerrar sessão inexistente: ${nomeSessao}`);
        return res.status(404).json({ error: 'Sessão não encontrada.' });
    }
});


app.get('/status-sessao/:nomeSessao', (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (!sessoes[nomeSessao]) {
        return res.status(404).json({ status: 'Sessão não encontrada' });
    }

    sessoes[nomeSessao].then((client) => {
        client.getConnectionState().then((state) => {
            if (state === 'CONNECTED') {
                res.status(200).json({ status: 'Conectado' });
            } else if (state === 'DISCONNECTED') {
                res.status(200).json({ status: 'Desconectado' });
            } else {
                res.status(200).json({ status: 'Aguardando conexão' });
            }
        }).catch((error) => {
            console.error(`Erro ao verificar estado da sessão ${nomeSessao}:`, error);
            res.status(500).json({ error: 'Erro ao verificar estado da sessão.' });
        });
    }).catch((error) => {
        console.error(`Erro ao acessar sessão ${nomeSessao}:`, error);
        res.status(500).json({ error: 'Erro ao acessar sessão.' });
    });
});

// Rota para verificar ou gerar QR Code
// Função para gerar o QR Code e enviar a resposta
app.get('/gerar-qrcode/:nomeSessao', (req, res) => {
    const nomeSessao = req.params.nomeSessao;

    if (sessoes[nomeSessao]) {
        sessoes[nomeSessao].then((client) => {
            client.getConnectionState().then((state) => {
                if (state === 'CONNECTED') {
                    // Verifica se a resposta já foi enviada antes de tentar enviar outra
                    if (res.headersSent) {
                        console.log('Resposta já enviada para /gerar-qrcode.');
                        return;
                    }
                    return res.status(200).json({ status: 'Sessão já conectada' });
                } else {
                    // Aqui geramos o QR Code apenas uma vez
                    if (!client.qrCodeSent) {
                        client.qrCodeSent = true; // Marca para evitar que o QR Code seja enviado várias vezes
                        criarSessao(
                            nomeSessao,
                            (qrCode) => {
                                // Verifica se a resposta já foi enviada antes de tentar enviar outra
                                if (res.headersSent) {
                                    console.log('Resposta já enviada para /gerar-qrcode.');
                                    return;
                                }
                                res.status(200).json({ status: 'Aguardando conexão', qrcode: qrCode });
                            },
                            (status) => {
                                // Verifica se a resposta já foi enviada antes de tentar enviar outra
                                if (res.headersSent) {
                                    console.log('Resposta já enviada para /gerar-qrcode.');
                                    return;
                                }
                                res.status(200).json({ status });
                            }
                        );
                    } else {
                        console.log(`QR Code já foi enviado para a sessão ${nomeSessao}`);
                    }
                }
            }).catch((error) => {
                console.error(`Erro ao verificar estado da sessão ${nomeSessao}:`, error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Erro ao verificar estado da sessão.' });
                }
            });
        });
    } else {
        // Se a sessão não existe, criamos uma nova sessão e geramos o QR Code
        criarSessao(
            nomeSessao,
            (qrCode) => {
                // Verifica se a resposta já foi enviada antes de tentar enviar outra
                if (res.headersSent) {
                    console.log('Resposta já enviada para /gerar-qrcode.');
                    return;
                }
                res.status(200).json({ status: 'Aguardando conexão', qrcode: qrCode });
            },
            (status) => {
                // Verifica se a resposta já foi enviada antes de tentar enviar outra
                if (res.headersSent) {
                    console.log('Resposta já enviada para /gerar-qrcode.');
                    return;
                }
                res.status(200).json({ status });
            }
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