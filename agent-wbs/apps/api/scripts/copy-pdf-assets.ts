// 빌드 뒤 PDF 자산(화면 CSS·글꼴)을 dist/pdf/assets에 복사한다. 왜: 운영에는 api 산출물만 배포한다(src/pdf/assets.ts).
import { fileURLToPath } from 'node:url';
import { copyPdfAssets } from '../src/pdf/assets.ts';

await copyPdfAssets(fileURLToPath(new URL('../dist/pdf/assets', import.meta.url)));
