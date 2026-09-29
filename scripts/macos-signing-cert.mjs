// SPDX-License-Identifier: AGPL-3.0-only
/**
 * **The certificate a Mac release is signed with, until there is a Developer ID** (D207).
 *
 * An ad-hoc signature's designated requirement is the binary's own hash, so to macOS every
 * release is a different app: Accessibility, which computer control cannot work without, is
 * lost on each update and has to be switched off and on again in System Settings. Signed with a
 * certificate, the requirement becomes *this identifier, signed by this certificate*, which the
 * next release meets too — so a grant survives updates. A self-signed certificate does that and
 * costs nothing. It does not satisfy Gatekeeper, and it cannot be notarised; only a Developer ID
 * does either.
 *
 * Run it once, on the owner's Mac:
 *
 *     node scripts/macos-signing-cert.mjs
 *
 * It makes the certificate and its key, packs them into a password-protected `.p12` under
 * `~/.alexia/macos-signing/`, signs a throwaway binary with it in a keychain of its own to prove
 * `security` and `codesign` accept it the way the release job will, and prints the secrets to
 * set. It never sets them, and never touches the login keychain.
 *
 * **Run again, it makes nothing.** It finds the `.p12`, checks it, and prints the same secrets.
 * The certificate's hash is inside every installed Alexia's grant, so a second certificate is not
 * a replacement — it is every user switching Accessibility off and on once more. Losing the
 * `.p12` costs the same, so it belongs in a password manager beside `~/.alexia/updater.key`.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const NAME = 'Alexia Self-Signed Code Signing'
// Twenty years. Nothing checks the date once an app is installed — the grant names the
// certificate, not its validity — but a signature taken after expiry is refused at signing time,
// and the day that happens should be somebody else's problem.
const DAYS = 7305

const folder = join(homedir(), '.alexia', 'macos-signing')
const p12 = join(folder, 'alexia-signing.p12')
const passwordFile = join(folder, 'password')

if (process.platform !== 'darwin') {
  console.error('This makes a macOS code-signing identity and checks it with `security` and `codesign`, so it runs on a Mac.')
  process.exit(1)
}

/** A command that must succeed. The password travels in the environment, never on a command line `ps` can read. */
function run(command, args, options = {}) {
  const done = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (done.status !== 0) {
    throw new Error(`${command} ${args[0]} failed:\n${done.stderr || done.stdout}`)
  }
  return done.stdout
}

// macOS's own `openssl`, which is LibreSSL, on purpose. Its PKCS#12 defaults (3DES for the key,
// SHA-1 for the MAC) are the ones every macOS `security import` accepts, including an older one
// on a CI runner; OpenSSL 3's AES defaults are refused by some. Said explicitly, so a different
// `openssl` first on PATH could not change it.
const openssl = '/usr/bin/openssl'

const made = !existsSync(p12)
if (made) {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const scratch = mkdtempSync(join(tmpdir(), 'alexia-signing-'))
  try {
    // What `codesign` wants of a leaf and nothing more: a signature key, used for code.
    const config = join(scratch, 'cert.cnf')
    writeFileSync(
      config,
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = codesign',
        '[dn]',
        `CN = ${NAME}`,
        '[codesign]',
        'basicConstraints = critical, CA:false',
        'keyUsage = critical, digitalSignature',
        'extendedKeyUsage = critical, codeSigning',
        'subjectKeyIdentifier = hash',
        '',
      ].join('\n'),
    )
    const key = join(scratch, 'key.pem')
    const cert = join(scratch, 'cert.pem')
    run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(DAYS), '-config', config, '-keyout', key, '-out', cert])

    const password = randomBytes(24).toString('base64url')
    writeFileSync(passwordFile, password, { mode: 0o600 })
    run(
      openssl,
      ['pkcs12', '-export', '-name', NAME, '-inkey', key, '-in', cert, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-passout', 'env:ALEXIA_P12_PASSWORD', '-out', p12],
      { env: { ...process.env, ALEXIA_P12_PASSWORD: password } },
    )
    chmodSync(p12, 0o600)
  } finally {
    // The unencrypted key existed for a second, in a folder only this user can read, and is gone.
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (!existsSync(passwordFile)) throw new Error(`${p12} is here but its password (${passwordFile}) is not.`)
const password = readFileSync(passwordFile, 'utf8').trim()
const withPassword = { env: { ...process.env, ALEXIA_P12_PASSWORD: password } }

// The certificate back out of the .p12 — which proves the password opens it — and its SHA-1,
// which is what a designated requirement's `certificate leaf = H"…"` names and what `codesign`
// accepts as an identity.
const pem = run(openssl, ['pkcs12', '-in', p12, '-nokeys', '-clcerts', '-passin', 'env:ALEXIA_P12_PASSWORD'], withPassword)
const fingerprint = run(openssl, ['x509', '-noout', '-fingerprint', '-sha1', '-enddate'], { input: pem })
const sha1 = /Fingerprint=([0-9A-F:]+)/i.exec(fingerprint)?.[1].replaceAll(':', '').toUpperCase()
const expires = /notAfter=(.+)/.exec(fingerprint)?.[1]
if (!sha1) throw new Error(`could not read the certificate in ${p12}`)

// The release job's import, rehearsed: a keychain of its own, the .p12 imported the way
// `apple-actions/import-codesign-certs` does it, the same partition list (without which
// `codesign` stops at a dialog nobody on a runner can answer), and a binary signed by hash. The
// keychain is never added to the search list, and is deleted whatever happens.
const rehearsal = mkdtempSync(join(tmpdir(), 'alexia-signing-check-'))
const keychain = join(rehearsal, 'check.keychain-db')
const keychainPassword = randomBytes(16).toString('hex')
let requirement
try {
  run('security', ['create-keychain', '-p', keychainPassword, keychain])
  run('security', ['unlock-keychain', '-p', keychainPassword, keychain])
  run('security', ['import', p12, '-k', keychain, '-f', 'pkcs12', '-T', '/usr/bin/codesign', '-P', password])
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-k', keychainPassword, keychain])
  const binary = join(rehearsal, 'alexia-signing-check')
  copyFileSync('/usr/bin/true', binary)
  run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--keychain', keychain, '--sign', sha1, binary])
  run('codesign', ['--verify', '--strict', binary])
  requirement = spawnSync('codesign', ['-d', '-r-', binary], { encoding: 'utf8' }).stdout.trim()
} finally {
  spawnSync('security', ['delete-keychain', keychain], { stdio: 'ignore' })
  rmSync(rehearsal, { recursive: true, force: true })
}
if (!requirement.includes(`certificate leaf = H"${sha1.toLowerCase()}"`)) {
  throw new Error(`a binary signed with this certificate came out with a requirement that does not name it:\n${requirement}`)
}

const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: import.meta.dirname, encoding: 'utf8' }).stdout ?? ''
const repo = /github\.com[:/]([^/]+\/[^/.\s]+)/.exec(origin)?.[1] ?? 'cr3studioo/Alexia'
const base64 = readFileSync(p12).toString('base64')

console.log(`
${made ? 'Made' : 'Found'} the certificate. Nothing was sent anywhere.

  Identity   ${NAME}
  SHA-1      ${sha1}
  Expires    ${expires}
  Kept in    ${p12}
             ${passwordFile}

A binary signed with it, in a throwaway keychain, came out with:

  ${requirement}

That is the requirement every release from now on will share, and what an Accessibility grant
is kept against. Put both files in the password manager beside ~/.alexia/updater.key. If they
are lost, or this is ever run again after deleting them, every Mac with Alexia installed has to
grant Accessibility once more.

The .p12 as base64 (password-protected; it is what the first secret holds):

${base64}

Set these yourself — nothing here runs them:

  base64 -i ${p12} | gh secret set MACOS_SELF_SIGNED_CERTIFICATE --repo ${repo}
  gh secret set MACOS_SELF_SIGNED_CERTIFICATE_PASSWORD --repo ${repo} < ${passwordFile}
  gh variable set MACOS_SELF_SIGNED_IDENTITY --repo ${repo} --body ${sha1}

The third is a variable, not a secret: it is the certificate's hash, which is public in every
signed app, and the release log has to be able to print it. The release signs with that hash, so
a different certificate in the first secret fails the build instead of shipping.

Then release with sign_macos = self-signed.`)
