// Firma "ad-hoc" el .app de Mac después de compilarlo, antes de meterlo en el .dmg.
//
// No es la firma de pago de Apple (esa exige la cuenta de Developer, 99$/año):
// es una firma local, gratuita, sin verificar identidad ante Apple. Pero hace
// falta igual, porque en Mac con chip Apple Silicon (M1/M2/M3...) el sistema
// exige que TODO ejecutable tenga al menos esta firma para arrancar — sin
// ella, macOS lo rechaza con un mensaje de "está dañado" en vez de con el
// aviso normal de "desarrollador no identificado" que sí se puede saltar con
// clic derecho → Abrir.
//
// Si en el futuro se añaden los secretos de firma real de Apple (CSC_LINK),
// este paso se salta solo y deja que electron-builder firme de verdad.
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK) return; // ya hay firma real de Apple configurada

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterSign] Firmando ad-hoc (sin cuenta de Apple, solo para que arranque en Apple Silicon): ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
