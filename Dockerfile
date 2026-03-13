FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('node:http');const port=Number(process.env.PORT||3000);const req=http.get({host:'127.0.0.1',port,path:'/healthz',timeout:4000},(res)=>{process.exit(res.statusCode>=200&&res.statusCode<400?0:1);});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});"

CMD ["/app/docker-entrypoint.sh"]
