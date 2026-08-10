# Truco na Escola

Truco Paulista multiplayer para sala de aula.

## Funcionalidades

- Várias salas com código de 4 caracteres
- Reconexão automática (token no navegador)
- Modos 1v1 e Duplas (2v2)
- Espectador vê a mesa completa
- Mão ordenada por força
- Histórico das rodadas
- Times visualmente distintos
- Toasts de feedback
- Pronto para Render

## Rodar local

```bash
npm install
npm start
```

Abra http://localhost:3000

## Deploy no Render

1. Suba o projeto para o GitHub
2. Em [render.com](https://render.com) → **New** → **Web Service**
3. Conecte o repositório
4. Configurações:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Crie o serviço
6. Use o link gerado (ex: `https://truco-na-escola.onrender.com`)

> No plano gratuito o serviço “dorme” após ~15 min sem uso. O primeiro acesso pode demorar ~30–50s para acordar.

## Como jogar

1. Um aluno cria a sala e escolhe 1v1 ou Duplas
2. Recebe um código (ex: `K7M2`)
3. Os outros entram com o código e o nome
4. Quando todos entrarem, o jogo começa automaticamente
5. Se alguém cair, pode reabrir o link e reconecta sozinho