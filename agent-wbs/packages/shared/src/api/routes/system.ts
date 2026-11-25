import Type from 'typebox';
import { AnyOf } from '../common.ts';
import { operation } from '../operation.ts';

export const systemOperations = [
  operation({
    id: 'getHealth',
    method: 'GET',
    path: '/health',
    principal: 'none',
    summary: 'API 생존',
    responses: { 200: Type.Object({ status: AnyOf('ok') }) },
  }),
  operation({
    id: 'getDbHealth',
    method: 'GET',
    path: '/health/db',
    principal: 'none',
    summary: 'DB 연결',
    responses: { 200: Type.Object({ db: AnyOf('ok'), latencyMs: Type.Number({ minimum: 0 }) }) },
  }),
];
