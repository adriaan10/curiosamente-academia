// Prepara la carpeta web/ para desplegar: copia el bundle y los estilos que
// acaba de generar `npm run build` (mismo bundle.js que usa Electron, ya
// compilado para navegador), más el logo y el icono desde assets/. Se llama
// siempre después del build normal — ver "build:web" en package.json.
const fs = require('fs');
const path = require('path');

const copias = [
  [path.join('app', 'bundle.js'), path.join('web', 'bundle.js')],
  [path.join('app', 'styles.css'), path.join('web', 'styles.css')],
  [path.join('assets', 'logo.png'), path.join('web', 'logo.png')],
  [path.join('assets', 'icon.png'), path.join('web', 'icon.png')]
];

for (const [origen, destino] of copias) {
  fs.copyFileSync(origen, destino);
  console.log(`web/: copiado ${origen} -> ${destino}`);
}
