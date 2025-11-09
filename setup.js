const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();



async function setup(){
    const card = await prisma.cartao.create({
        data: {
            card_RFID: "550e8400-e29b-41d4-a716-446655440000",
            data_expedicao: new Date()
        }
    })

    await prisma.aluno.create({
        data: {
            Nome: "Henrique Barbosa Sampaio",
            Curso: "DSM",
            card_RFID: card.card_RFID,
            ra: 299921
        }
    })
}

setup()