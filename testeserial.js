const { SerialPort } = require('serialport');

const BAUD_RATE = 115200;
let recebeuAlgo = false;
let buffer = Buffer.alloc(0);
let port;

function mostrarLinha(linha) {
    if (!linha.length) return;

    const texto = linha.toString('ascii').trim();
    const legivel = [...linha].every(b => b === 9 || b === 32 || (b >= 33 && b <= 126));

    if (!legivel) {
        console.log('BOOT/RUIDO (HEX):', linha.toString('hex'));
        return;
    }

    console.log('SERIAL:', texto);

    if (texto === 'SMARTSTOCK|READY') console.log('>>> LEITOR PRONTO PARA RECEBER CARTÕES!');
    if (texto.startsWith('SMARTSTOCK|RFID|')) console.log('>>> CARTÃO IDENTIFICADO:', texto.split('|')[2]);
    if (texto.startsWith('SMARTSTOCK|ERROR|')) console.log('>>> PROBLEMA NO FIRMWARE/LEITOR:', texto.split('|').slice(2).join('|'));
}

// Descobre a porta: usa RFID_PORTA se existir; senão procura um chip CH340/CP210x.
async function escolherPorta() {
    if (process.env.RFID_PORTA) return process.env.RFID_PORTA;

    const portas = await SerialPort.list();
    const placa = portas.find(p =>
        /wch|silicon|ftdi/i.test(p.manufacturer || '') ||
        ['1A86', '10C4', '0403'].includes((p.vendorId || '').toUpperCase())
    );

    if (placa) {
        console.log(`Porta detectada automaticamente: ${placa.path} (${placa.manufacturer || 'USB serial'})`);
        return placa.path;
    }

    console.log('Nenhuma placa USB detectada. Usando COM8 por padrão.');
    return 'COM8';
}

// Pulso de reset estilo NodeMCU: sai do modo bootloader e reinicia o programa.
function resetarPlaca() {
    port.set({ dtr: false, rts: true }, () => {
        setTimeout(() => {
            port.set({ dtr: false, rts: false }, () => {
                console.log('Reset enviado à placa. Aguarde ~3 segundos...');
            });
        }, 150);
    });
}

async function iniciar() {
    const PORTA = await escolherPorta();

    port = new SerialPort({
        path: PORTA,
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
        rtscts: false
    });

    port.on('open', () => {
        console.log('================================');
        console.log('       TESTE SERIAL');
        console.log('================================');
        console.log(`PORTA ABERTA: ${PORTA}`);
        console.log(`VELOCIDADE: ${BAUD_RATE}`);
        console.log('Aguardando mensagens do ESP8266...');

        resetarPlaca();

        setTimeout(() => {
            if (!recebeuAlgo) {
                console.log('\n--- NADA RECEBIDO EM 10 SEGUNDOS ---');
                console.log('1) Aperte o botão RST da placa.');
                console.log('2) Feche a Arduino IDE e o Monitor Serial por completo.');
                console.log('3) Confirme que o firmware smart_stock_rfid.ino está gravado (115200 baud).');
                console.log('4) Troque o cabo USB (alguns só carregam, sem dados).\n');
            }
        }, 10000);
    });

    port.on('data', dados => {
        recebeuAlgo = true;
        buffer = Buffer.concat([buffer, dados]);

        let pos;
        while ((pos = buffer.indexOf(0x0A)) !== -1) {
            let linha = buffer.subarray(0, pos);
            if (linha.length && linha[linha.length - 1] === 0x0D) linha = linha.subarray(0, linha.length - 1);
            mostrarLinha(linha);
            buffer = buffer.subarray(pos + 1);
        }

        if (buffer.length > 1024) {
            console.log('DADOS INCOMPLETOS (HEX):', buffer.toString('hex'));
            buffer = Buffer.alloc(0);
        }
    });

    port.on('error', erro => console.error('ERRO SERIAL:', erro.message));
    port.on('close', () => console.log('PORTA SERIAL FECHADA.'));

    port.open(erro => {
        if (erro) {
            console.error(`NÃO FOI POSSÍVEL ABRIR ${PORTA}:`, erro.message);
            console.error('Feche a Arduino IDE / Monitor Serial e tente de novo.');
        }
    });
}

process.on('SIGINT', () => {
    console.log('\nEncerrando teste...');
    if (port && port.isOpen) port.close(() => process.exit(0));
    else process.exit(0);
});

iniciar().catch(erro => console.error('ERRO AO INICIAR:', erro.message));
