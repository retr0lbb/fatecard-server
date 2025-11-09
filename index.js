require('dotenv').config();
const express = require('express');
const cors = require("cors")
const { PrismaClient } = require('@prisma/client');

// Importa a correção para o BigInt
const jsonBigint = require('json-bigint-patch');
const app = express();
app.use(express.json());
app.use(cors({
  origin: "*"
}))

// Aplica a correção para o BigInt
app.set('json replacer', jsonBigint.replacer);
app.set('json spaces', 2);

const prisma = new PrismaClient();


/*
 * --- ROTAS DE TESTE (Atualizadas) ---
 */

// Rota para criar um ALUNO (e seu cartão)
app.post('/alunos', async (req, res) => {
  const { ra, nome, curso, data_expedicao } = req.body;
  try {
    const novoAluno = await prisma.aluno.create({
      data: {
        ra: BigInt(ra), // Converte para BigInt
        Nome: nome,
        Curso: curso,
        cartao: {
          create: {
            // card_RFID é gerado por @default(uuid())
            data_expedicao: new Date(data_expedicao) // Deve ser formato AAAA-MM-DD
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
      // id é gerado por @default(uuid())
      titulo,
      descricao,
      horario_inicio: new Date(horario_inicio),
      horario_fim: new Date(horario_fim),
      is_able_to_checkin: false // Padrão é desligado
    }
  });
  res.status(201).json(novaPalestra);
});

/*
 * --- ROTAS PRINCIPAIS (Atualizadas) ---
 */

// Rota para LISTAR PALESTRAS (com status calculado)
// (Mantida igual, mas lógica do status agora é híbrida)
app.get('/palestras', async (req, res) => {
  const palestras = await prisma.palestra.findMany();
  const agora = new Date();

  const palestrasComStatus = palestras.map(p => {
    let status;
    // O status de "Ativa" agora depende do booleano
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

// --- NOVA ROTA: "Iniciar/Pausar Palestra" ---
// Esta é a rota para os botões "Início" e "Pausa" da sua UI
app.patch('/palestras/:id/toggle-checkin', async (req, res) => {
  const { id } = req.params; // ID agora é UUID (String)
  const { status } = req.body; // true (para iniciar) ou false (para pausar)

  try {
    const palestra = await prisma.palestra.update({
      where: { id: id },
      data: { is_able_to_checkin: status }
    });
    res.json(palestra);
  } catch (e) {
    res.status(404).json({ error: 'Palestra não encontrada.' });
  }
});


// Rota para fazer CHECK-IN
app.post('/checkin', async (req, res) => {
  const { aluno_ra, palestra_id } = req.body;

  // 1. Verifica se a palestra existe e está HABILITADA
  const palestra = await prisma.palestra.findUnique({
    where: { id: palestra_id } // palestra_id agora é UUID (String)
  });

  if (!palestra) {
    return res.status(404).json({ error: 'Palestra não encontrada.' });
  }
  
  // LÓGICA ATUALIZADA:
  if (!palestra.is_able_to_checkin) {
    return res.status(403).json({ error: 'O check-in para esta palestra não está ativo.' });
  }

  // 2. Tenta criar o check-in
  try {
    const novoCheckin = await prisma.checkin.create({
      data: {
        aluno_ra: BigInt(aluno_ra), // Converte para BigInt
        palestra_id: palestra_id,
        // id do checkin é gerado por @default(uuid())
      }
    });
    res.status(201).json(novoCheckin);
  } catch (e) {
    res.status(409).json({ error: 'Aluno já fez check-in nesta palestra.' });
  }
});

// Rota para ver PRESENTES (quem fez check-in)
app.get('/palestras/:id/presentes', async (req, res) => {
  const { id } = req.params; // ID agora é UUID (String)
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

// --- ROTA: "Emitir Certificados" ---
app.post('/palestras/:id/emitir-certificados', async (req, res) => {
  const { id } = req.params; // ID da Palestra (UUID)

  try {
    // 1. Encontrar check-ins da palestra que NÃO tenham certificado
    const checkinsParaCertificar = await prisma.checkin.findMany({
      where: {
        palestra_id: id,
        certificado: null // O Prisma entende essa relação 1-para-1
      }
    });

    if (checkinsParaCertificar.length === 0) {
      return res.json({ message: "Nenhum certificado novo para emitir." });
    }
    
    // (Em um sistema real, aqui você geraria o PDF/Blob)
    const placeholderBlob = Buffer.from('PDF_PLACEHOLDER');

    // 2. Criar os certificados em lote
    const transacao = await prisma.$transaction(
      checkinsParaCertificar.map(checkin => 
        prisma.certificado.create({
          data: {
            // Linka usando o par de chaves
            aluno_ra: checkin.aluno_ra,
            palestra_id: checkin.palestra_id,
            file_blob: placeholderBlob
            // id (PK) e horario_expedicao são auto-gerados
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


// 4. Inicia o servidor
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});