FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY .env.example ./.env.example

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('node:http');const port=Number(process.env.PORT||3001);const req=http.get({host:'127.0.0.1',port,path:'/healthz',timeout:4000},(res)=>{process.exit(res.statusCode>=200&&res.statusCode<400?0:1);});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});"

CMD ["node", "src/server.js"]
