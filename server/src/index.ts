// 개발용 실행 진입점 (npm run dev / npm start). 배포용은 트레이 앱(app/main.mjs)
import { loadConfig } from './config.js';
import { startServer } from './server.js';

const cfg = loadConfig();

try {
  const running = await startServer(cfg);
  console.log(`remote-file-manager 서버 실행 중: ${running.addresses.join(', ')}`);
  console.log(`허용 IP 대역: ${cfg.allowedIps.length ? cfg.allowedIps.join(', ') : '(전체)'}`);
  const shutdown = () => {
    running.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err: any) {
  console.error(err.code === 'EADDRINUSE' ? `포트 ${cfg.port}가 이미 사용 중입니다 (서버가 이미 실행 중일 수 있음)` : err);
  process.exit(1);
}
