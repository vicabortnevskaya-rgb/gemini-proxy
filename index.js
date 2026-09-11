const http = require('http');
const https = require('https');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.APP_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Access Denied: Wrong App Token' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      let userText = data.contents[0].parts[0].text;
      const model = data.model || 'gemini-3.6-flash';

      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = userText.match(urlRegex);

      if (urls && urls.length > 0) {
        const urlToFetch = urls[0];
        try {
          const jinaData = await new Promise((resolve) => {
            https.get(`https://r.jina.ai/${urlToFetch}`, (resp) => {
              let t = '';
              resp.on('data', c => t += c);
              resp.on('end', () => resolve(t));
            });
          });
          const cleanText = jinaData.substring(0, 25000);
          data.contents[0].parts[0].text = userText + "\n\n--- МАТЕРИАЛ ПО ССЫЛКЕ ---\n" + cleanText + "\n--- КОНЕЦ МАТЕРИАЛА ---";
        } catch (e) {}
      }

      delete data.model;

      const geminiData = JSON.stringify(data);
      
      // ИСПОЛЬЗУЕМ СТРИМИНГОВЫЙ ЭНДПОИНТ GOOGLE
      const geminiReqOptions = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(geminiData)
        }
      };

      const proxyReq = https.request(geminiReqOptions, (proxyRes) => {
        // Устанавливаем заголовки потокового ответа для клиента
        res.writeHead(proxyRes.statusCode, { 
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        let buffer = '';

        proxyRes.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Сохраняем неполную строку в буфер

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
              const jsonStr = trimmed.replace(/^data:\s*/, '');
              if (jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  res.write(text); // Шлем чистый текст во Flutter по мере готовности
                }
              } catch (e) {
                // Игнорируем ошибки неполных JSON-чанк-данных
              }
            }
          }
        });

        proxyRes.on('end', () => {
          res.end();
        });
      });

      proxyReq.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });

      proxyReq.write(geminiData);
      proxyReq.end();

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT);
