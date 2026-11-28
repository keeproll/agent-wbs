import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 시험 전용 CA·서버 인증서. 이 PC의 시계 역행을 고려해 시작 시각을 5분 앞당긴다. */
export function testCertificates() {
  const dir = mkdtempSync(join(tmpdir(), 'awbs-W5-tls-'));
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const start = new Date(Date.now() - 300_000).toISOString().replace(/[-:TZ]/g, '').slice(0, 14) + 'Z';
  try {
    writeFileSync(join(dir, 'index'), '');
    writeFileSync(join(dir, 'serial'), '01\n');
    writeFileSync(join(dir, 'ca.cnf'), `[ca]
default_ca = local
[local]
database = ${dir}/index
new_certs_dir = ${dir}
serial = ${dir}/serial
private_key = ${dir}/ca.key
certificate = ${dir}/ca.crt
default_md = sha256
default_days = 2
policy = names
[names]
commonName = supplied
[ca_ext]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
[server]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
[wrong]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:wrong.invalid
`);
    openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.csr', '-subj', '/CN=awbs-W5-root');
    openssl('x509', '-req', '-in', 'ca.csr', '-signkey', 'ca.key', '-out', 'bootstrap.crt', '-days', '2', '-extfile', 'ca.cnf', '-extensions', 'ca_ext');
    openssl('ca', '-batch', '-selfsign', '-config', 'ca.cnf', '-cert', 'bootstrap.crt', '-in', 'ca.csr', '-out', 'ca.crt', '-startdate', start, '-extensions', 'ca_ext');
    for (const name of ['server', 'wrong']) {
      openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=awbs-W5-${name}`);
      openssl('ca', '-batch', '-config', 'ca.cnf', '-in', `${name}.csr`, '-out', `${name}.crt`, '-startdate', start, '-extensions', name);
    }
    return {
      ca: join(dir, 'ca.crt'),
      server: { key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) },
      wrong: { key: readFileSync(join(dir, 'wrong.key')), cert: readFileSync(join(dir, 'wrong.crt')) },
      close: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}
