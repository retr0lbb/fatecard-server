require('dotenv').config();
const express = require('express');
const cors = require("cors");
const { PrismaClient } = require('@prisma/client');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Importa a correção para o BigInt
const jsonBigint = require('json-bigint-patch');
const app = express();
app.use(express.json());
app.use(cors({
  origin: "*"
}));

// Aplica a correção para o BigInt
app.set('json replacer', jsonBigint.replacer);
app.set('json spaces', 2);

const prisma = new PrismaClient();

// ============================================
// CONFIGURAÇÃO SERIAL DO ARDUINO
// ============================================

const SERIAL_CONFIG = {
  port: process.env.ARDUINO_PORT || 'COM3',  // ← Configure no .env ou mude aqui
  baudRate: 115200
};

let serialPort;
let parser;
let serialConectado = false;

// Função para inicializar a porta serial
function inicializarSerial() {
  try {
    console.log('🔌 Tentando conectar ao Arduino...');
    console.log(`   Porta: ${SERIAL_CONFIG.port}`);
    
    serialPort = new SerialPort({
      path: SERIAL_CONFIG.port,
      baudRate: SERIAL_CONFIG.baudRate
    });
    
    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
    
    serialPort.on('open', () => {
      console.log('✅ Arduino conectado com sucesso!');
      serialConectado = true;
    });
    
    serialPort.on('error', (err) => {
      console.error('❌ Erro na serial:', err.message);
      serialConectado = false;
      
      // Listar portas disponíveis
      SerialPort.list().then(ports => {
        console.log('\n📋 Portas seriais disponíveis:');
        ports.forEach(port => {
          console.log(`   - ${port.path}: ${port.manufacturer || 'Desconhecido'}`);
        });
        console.log('\n💡 Configure a porta correta no .env: ARDUINO_PORT=COMx\n');
      });
    });
    
    serialPort.on('close', () => {
      console.log('⚠️  Conexão serial fechada');
      serialConectado = false;
    });
    
    // Processar dados recebidos do Arduino
    parser.on('data', async (line) => {
      try {
        const data = JSON.parse(line);
        
        if (data.event === 'card_detected') {
          console.log('\n🎫 CARTÃO DETECTADO!');
          console.log(`   UUID: ${data.uuid}`);
          console.log(`   UID Hardware: ${data.uid_hardware}`);
          
          // Processar o cartão automaticamente
          await processarCartaoRFID(data.uuid, data.uid_hardware);
        } else if (data.event === 'card_removed') {
          console.log('👋 Cartão removido\n');
        } else if (data.status === 'ready') {
          console.log('✅ Arduino pronto e aguardando cartões...\n');
        } else if (data.error) {
          console.error(`⚠️  Erro no Arduino: ${data.error}`);
        }
        
      } catch (e) {
        // Não é JSON, pode ser mensagem de debug
        if (line.trim()) {
          console.log(`[Arduino] ${line}`);
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Erro ao inicializar serial:', error.message);
    serialConectado = false;
  }
}

// Função para processar cartão RFID automaticamente
async function processarCartaoRFID(uuid, uidHardware) {
  try {
    // 1. Buscar o cartão pelo UUID RFID
    const cartao = await prisma.cartao.findUnique({
      where: { card_RFID: uuid },
      include: { aluno: true }
    });
    
    if (!cartao) {
      console.log('❌ Cartão não cadastrado no sistema');
      console.log(`   UUID: ${uuid}\n`);
      return;
    }
    
    console.log(`✅ Aluno identificado: ${cartao.aluno.Nome} (RA: ${cartao.aluno.ra})`);
    
    // 2. Buscar palestra ATIVA (com check-in habilitado)
    const palestraAtiva = await prisma.palestra.findFirst({
      where: { is_able_to_checkin: true }
    });
    
    if (!palestraAtiva) {
      console.log('⚠️  Nenhuma palestra ativa no momento');
      console.log(`   Aluno: ${cartao.aluno.Nome}\n`);
      return;
    }
    
    console.log(`📍 Palestra ativa: ${palestraAtiva.titulo}`);
    
    // 3. Verificar se já fez check-in
    const checkinExistente = await prisma.checkin.findUnique({
      where: {
        aluno_ra_palestra_id: {
          aluno_ra: cartao.aluno.ra,
          palestra_id: palestraAtiva.id
        }
      }
    });
    
    if (checkinExistente) {
      console.log('⚠️  Aluno já fez check-in nesta palestra');
      console.log(`   Horário anterior: ${checkinExistente.horario_checkin}\n`);
      return;
    }
    
    // 4. Fazer o CHECK-IN!
    const novoCheckin = await prisma.checkin.create({
      data: {
        aluno_ra: cartao.aluno.ra,
        palestra_id: palestraAtiva.id
      }
    });
    
    console.log('✅ CHECK-IN REALIZADO COM SUCESSO!');
    console.log(`   Aluno: ${cartao.aluno.Nome}`);
    console.log(`   Palestra: ${palestraAtiva.titulo}`);
    console.log(`   Horário: ${novoCheckin.horario_checkin}\n`);
    
  } catch (error) {
    console.error('❌ Erro ao processar cartão:', error.message);
    console.log('');
  }
}

// ============================================
// ROTAS DE TESTE (Atualizadas)
// ============================================

// Rota para criar um ALUNO (e seu cartão)
app.post('/alunos', async (req, res) => {
  const { ra, nome, curso, data_expedicao, card_rfid } = req.body;
  try {
    const novoAluno = await prisma.aluno.create({
      data: {
        ra: BigInt(ra),
        Nome: nome,
        Curso: curso,
        cartao: {
          create: {
            card_RFID: card_rfid, // UUID do cartão RFID
            data_expedicao: new Date(data_expedicao)
          }
        }
      },
      include: { cartao: true }
    });
    res.status(201).json(novoAluno);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'Erro ao criar aluno.', details: e.message });
  }
});

// Rota para criar uma PALESTRA
app.post('/palestras', async (req, res) => {
  const { titulo, descricao, horario_inicio, horario_fim } = req.body;
  const novaPalestra = await prisma.palestra.create({
    data: {
      titulo,
      descricao,
      horario_inicio: new Date(horario_inicio),
      horario_fim: new Date(horario_fim),
      is_able_to_checkin: false
    }
  });
  res.status(201).json(novaPalestra);
});

// ============================================
// ROTAS PRINCIPAIS (Atualizadas)
// ============================================

// Rota para LISTAR PALESTRAS (com status calculado)
app.get('/palestras', async (req, res) => {
  const palestras = await prisma.palestra.findMany();
  const agora = new Date();

  const palestrasComStatus = palestras.map(p => {
    let status;
    if (p.is_able_to_checkin) {
      status = 'ATIVA';
    } else if (agora < p.horario_inicio) {
      status = 'PENDENTE';
    } else {
      status = 'CONCLUIDA_OU_PAUSADA';
    }
    return { ...p, status };
  });

  res.json(palestrasComStatus);
});

// Rota para "Iniciar/Pausar Palestra"
app.patch('/palestras/:id/toggle-checkin', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const palestra = await prisma.palestra.update({
      where: { id: id },
      data: { is_able_to_checkin: status }
    });
    
    if (status) {
      console.log(`\n🟢 Palestra INICIADA: ${palestra.titulo}`);
      console.log('   Check-in habilitado via RFID\n');
    } else {
      console.log(`\n🔴 Palestra PAUSADA: ${palestra.titulo}`);
      console.log('   Check-in desabilitado\n');
    }
    
    res.json(palestra);
  } catch (e) {
    res.status(404).json({ error: 'Palestra não encontrada.' });
  }
});

// Rota para fazer CHECK-IN (manual via API)
app.post('/checkin', async (req, res) => {
  const { aluno_ra, palestra_id } = req.body;

  const palestra = await prisma.palestra.findUnique({
    where: { id: palestra_id }
  });

  if (!palestra) {
    return res.status(404).json({ error: 'Palestra não encontrada.' });
  }
  
  if (!palestra.is_able_to_checkin) {
    return res.status(403).json({ error: 'O check-in para esta palestra não está ativo.' });
  }

  try {
    const novoCheckin = await prisma.checkin.create({
      data: {
        aluno_ra: BigInt(aluno_ra),
        palestra_id: palestra_id,
      }
    });
    res.status(201).json(novoCheckin);
  } catch (e) {
    res.status(409).json({ error: 'Aluno já fez check-in nesta palestra.' });
  }
});

// Rota para ver PRESENTES (quem fez check-in)
app.get('/palestras/:id/presentes', async (req, res) => {
  const { id } = req.params;
  const checkins = await prisma.checkin.findMany({
    where: { palestra_id: id },
    include: {
      aluno: { select: { ra: true, Nome: true, Curso: true } }
    }
  });

  const presentes = checkins.map(c => ({
    ...c.aluno,
    horario_checkin: c.horario_checkin
  }));

  res.json(presentes);
});

// Rota para "Emitir Certificados"
app.post('/palestras/:id/emitir-certificados', async (req, res) => {
  const { id } = req.params;

  try {
    const checkinsParaCertificar = await prisma.checkin.findMany({
      where: {
        palestra_id: id,
        certificado: null
      }
    });

    if (checkinsParaCertificar.length === 0) {
      return res.json({ message: "Nenhum certificado novo para emitir." });
    }
    
    const placeholderBlob = Buffer.from('PDF_PLACEHOLDER');

    const transacao = await prisma.$transaction(
      checkinsParaCertificar.map(checkin => 
        prisma.certificado.create({
          data: {
            aluno_ra: checkin.aluno_ra,
            palestra_id: checkin.palestra_id,
            file_blob: placeholderBlob
          }
        })
      )
    );

    res.status(201).json({ message: `${transacao.length} certificados emitidos.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao emitir certificados.', details: e.message });
  }
});

// ============================================
// NOVA ROTA: Status do Arduino
// ============================================

app.get('/api/arduino/status', (req, res) => {
  res.json({
    conectado: serialConectado,
    porta: SERIAL_CONFIG.port,
    baudRate: SERIAL_CONFIG.baudRate
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log('='.repeat(60));
  
  // Inicializar serial 2 segundos após servidor iniciar
  setTimeout(() => {
    inicializarSerial();
  }, 2000);
});

// Encerramento gracioso
process.on('SIGINT', () => {
  console.log('\n👋 Encerrando servidor...');
  if (serialPort?.isOpen) {
    serialPort.close();
  }
  prisma.$disconnect();
  process.exit(0);
});