require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises;
const { Pool } = require('pg');
const puppeteer = require('puppeteer');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    }
});
console.log("Conectado ao banco de dados.");

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.get('/api/documentos', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nome FROM termosign.documentos");
        res.json(result.rows);
    } catch (err){
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/condominios', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nome FROM termosign.condominios");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/gerar-termo', upload.fields([
    { name: 'imgCotas', maxCount: 1 },
    { name: 'imgCondominio', maxCount: 1 },
]), async (req, res) => {
    try {
        const dadosFormulario = req.body;
        
        const condoResult = await pool.query("SELECT * FROM termosign.condominios WHERE id = $1", [dadosFormulario.condominioId]);
        if (condoResult.rows.length === 0) {
            return res.status(404).json({ error: `Condomínio com ID '${dadosFormulario.condominioId}' não encontrado.` });
        }
        const condoInfo = condoResult.rows[0];

        const documentoId = dadosFormulario.documentoId || 'acordo_extra';
        const docResult = await pool.query("SELECT * FROM termosign.documentos WHERE id = $1", [documentoId]);
        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: `Documento com ID '${documentoId}' não encontrado.` });
        }
        const docInfo = docResult.rows[0];
        
        const templateFilename = docInfo.templatefile;
        const filePath = `./templates/${templateFilename}`;
        const htmlTemplate = await fs.readFile(filePath, 'utf8');

        // Lendo as imagens do papel timbrado
        const cabecalhoBuffer = await fs.readFile('./cabecalho.png');
        const rodapeBuffer = await fs.readFile('./rodape.png');
        const cabecalhoSrc = `data:image/png;base64,${cabecalhoBuffer.toString('base64')}`;
        const rodapeSrc = `data:image/png;base64,${rodapeBuffer.toString('base64')}`;

        const replacements = {
            // Note que não há mais placeholders de imagem de cabeçalho/rodapé aqui
            '{{condominio}}': condoInfo.nome,
            '{{cnpj_condominio}}': condoInfo.cnpj,
            '{{endereco_cond}}': condoInfo.endereco,
            '{{bairro_cond}}': condoInfo.bairro,
            '{{cidade_cond}}': condoInfo.cidade,
            '{{sindico}}': condoInfo.sindico,
            '{{devedor}}': dadosFormulario.devedor || '',
            '{{cpf}}': dadosFormulario.cpf || '',
            '{{endereco_devedor}}': dadosFormulario.endereco_devedor || '',
            '{{telefone}}': dadosFormulario.telefone || '',
            '{{email}}': dadosFormulario.email || '',
            '{{forma_pagamento}}': dadosFormulario.forma_pagamento || '',
            '{{CIDADE}}': condoInfo.cidade || 'Sua Cidade',
            '{{DATA_DIA}}': new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
            '{{IMAGEM_COTAS}}': '',
            '{{IMAGEM_CALCULO}}': ''
        };

        let htmlContent = htmlTemplate;
        for (const [key, value] of Object.entries(replacements)) {
            const finalValue = value !== null && value !== undefined ? value : '';
            htmlContent = htmlContent.replace(new RegExp(key, 'g'), finalValue);
        }

        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        // A SOLUÇÃO DEFINITIVA ESTÁ AQUI
        const pdfBytes = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true, // Habilita o uso dos templates abaixo
            
            // Injeta o HTML do cabeçalho com a imagem em Base64
            headerTemplate: `<div style="width: 100%;"><img src="${cabecalhoSrc}" style="width: 100%;" /></div>`,
            
            // Injeta o HTML do rodapé com a imagem em Base64
            footerTemplate: `<div style="width: 100%;"><img src="${rodapeSrc}" style="width: 100%;" /></div>`,
            
            // Define as margens ONDE o cabeçalho/rodapé irão viver, empurrando o conteúdo principal
            margin: {
                top: '5cm',      // Ajuste este valor para a altura EXATA do seu cabeçalho
                bottom: '4cm',   // Ajuste este valor para a altura EXATA do seu rodapé
                left: '2cm',
                right: '2cm'
            }
        });
        
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="termo-definitivo.pdf"`);
        res.send(pdfBytes);
    } catch (error) {
        console.error("Erro ao gerar termo: ", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});