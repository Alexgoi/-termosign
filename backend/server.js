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
    { name: 'imgCalculo', maxCount: 1 }, // Corrigido de imgCondominio para imgCalculo
]), async (req, res) => {
    try {
        const dadosFormulario = req.body;
        
        const condoResult = await pool.query("SELECT * FROM termosign.condominios WHERE id = $1", [dadosFormulario.condominioId]);
        if (condoResult.rows.length === 0) {
            return res.status(404).json({ error: `Condomínio não encontrado.` });
        }
        const condoInfo = condoResult.rows[0];

        const documentoId = dadosFormulario.documentoId || 'acordo_extra';
        const docResult = await pool.query("SELECT templatefile FROM termosign.documentos WHERE id = $1", [documentoId]);
        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: `Documento não encontrado.` });
        }
        
        const templateFilename = docResult.rows[0].templatefile;
        const filePath = `./templates/${templateFilename}`;
        let htmlContent = await fs.readFile(filePath, 'utf8');

        // Lendo as imagens do papel timbrado
        const cabecalhoBuffer = await fs.readFile('./cabecalho.png');
        const rodapeBuffer = await fs.readFile('./rodape.png');
        const cabecalhoSrc = `data:image/png;base64,${cabecalhoBuffer.toString('base64')}`;
        const rodapeSrc = `data:image/png;base64,${rodapeBuffer.toString('base64')}`;

        // Lendo as imagens do formulário (se existirem)
        const imgCotasSrc = req.files['imgCotas'] ? `data:${req.files['imgCotas'][0].mimetype};base64,${req.files['imgCotas'][0].buffer.toString('base64')}` : '';
        const imgCalculoSrc = req.files['imgCalculo'] ? `data:${req.files['imgCalculo'][0].mimetype};base64,${req.files['imgCalculo'][0].buffer.toString('base64')}` : '';


        const replacements = {
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
            '{{valor_total}}': dadosFormulario.valor_total || '0,00',
            '{{forma_pagamento}}': dadosFormulario.forma_pagamento || '',
            '{{CIDADE}}': condoInfo.cidade || '',
            '{{DATA_DIA}}': new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
            '{{IMAGEM_COTAS}}': imgCotasSrc,
            '{{IMAGEM_CALCULO}}': imgCalculoSrc
        };

        for (const [key, value] of Object.entries(replacements)) {
            const finalValue = value || '';
            htmlContent = htmlContent.replace(new RegExp(key, 'g'), finalValue);
        }
        
        const finalHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    html, body { font-family: 'Helvetica', 'Arial', sans-serif; font-size: 11pt; margin: 0; padding: 0; }
                    table.layout { width: 100%; border-collapse: collapse; }
                    thead, tfoot { display: table-header-group; }
                    tbody { display: table-row-group; }
                    tr { page-break-inside: avoid; }
                    td.content { padding: 0 2cm; }
                </style>
            </head>
            <body>
                <table class="layout">
                    <thead>
                        <tr>
                            <td>
                                <div style="height: 4cm;"> 
                                    <img src="${cabecalhoSrc}" style="width: 100%; height: 100%; position: fixed; top: 0; left: 0; right: 0;">
                                </div>
                            </td>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td class="content">
                                ${htmlContent}
                            </td>
                        </tr>
                    </tbody>
                    <tfoot>
                        <tr>
                            <td>
                                <div style="height: 3.5cm;"> 
                                    <img src="${rodapeSrc}" style="width: 100%; height: 100%; position: fixed; bottom: 0; left: 0; right: 0;">
                                </div>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </body>
            </html>
        `;

        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        await page.setContent(finalHtml, { waitUntil: 'networkidle0' });
        
        const pdfBytes = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 } // Margens controladas pelo HTML
        });
        
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="termo-gerado.pdf"`);
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