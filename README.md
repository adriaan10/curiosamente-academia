# Curiosamente — App de gestión de la academia

Aplicación de escritorio (Windows) para el equipo de la Academia Curiosamente:
base de datos de alumnos por profesor y generación de recibos mensuales en un clic,
con envío por WhatsApp. Los datos se sincronizan entre todos los equipos de la
academia a través de Supabase (nube).

## Estructura

| Carpeta / archivo | Qué es |
|---|---|
| `main.js`, `preload.js` | Proceso principal de Electron (ventana, guardado de PDF, WhatsApp) |
| `src/` | Código de la interfaz (login, alumnos, recibos, ajustes) |
| `src/lib/numeroALetras.js` | Conversión de importe a letras (210 → "Doscientos diez") |
| `src/lib/pdf.js` | Generación del PDF del recibo (plantilla Curiosamente) |
| `app/` | HTML/CSS + bundle compilado que carga Electron |
| `supabase/migration.sql` | Esquema de base de datos con seguridad por profesor (RLS) |
| `assets/logo.png` | *(opcional)* logo real de la academia; si existe, se usa en el PDF |
| `test/test-pdf.mjs` | Tests de letras/concepto/PDF (`npm test`) |

## Puesta en marcha (una sola vez)

### 1. Proyecto Supabase — ✅ ya creado (08/07/2026)

- Proyecto: **Curiosamente** (`rwwszlyktvpszcdgwyyu`, región `eu-west-1`)
- URL: `https://rwwszlyktvpszcdgwyyu.supabase.co`
- Clave pública (para la pantalla de configuración de la app):
  `sb_publishable_1rEGTYk5JAM3JKTKaF7bxQ__DR2tngn`
- El esquema (`supabase/migration.sql`) ya está aplicado.

Solo falta crear los usuarios de los profesores:

3. En **Authentication → Users → Add user**, crear un usuario por profesor
   (email + contraseña). Al crearlo se genera solo su ficha de profesor.
   - Para que un usuario sea **administrador** (ve a todos los alumnos), tras crearlo
     ejecutar en SQL Editor:
     `update profesores set es_admin = true where email = 'admin@ejemplo.com';`
   - Para cambiar el nombre visible:
     `update profesores set nombre = 'Nombre Apellido' where email = '...';`

### 2. Instalar la app en cada equipo

```bash
npm install
npm start
```

La conexión viene ya configurada en `config.defaults.json` (incluido en la carpeta),
así que la app va directa a la pantalla de login. Solo si algún día cambia el proyecto
Supabase habrá que actualizar ese archivo (o usar Ajustes → Cambiar datos de conexión).

Para generar un instalador de Windows sin publicarlo: `npm run dist` (queda en `dist/`).

## Repositorio y actualizaciones automáticas

El código vive en un repositorio **público** de GitHub:
**[github.com/adriaan10/curiosamente-academia](https://github.com/adriaan10/curiosamente-academia)**.
Es público para que la auto-actualización funcione en los ordenadores de la academia
sin guardar ninguna contraseña dentro del programa — no hay secretos reales en el
código (la clave de Supabase incluida es la "publicable", pensada para ir en apps
cliente; la seguridad real la aplican las reglas RLS del servidor).

La app trae integrado `electron-updater`: al abrirse comprueba en segundo plano si
hay una versión más nueva publicada en GitHub, la descarga sola si la hay, y se
actualiza en el siguiente cierre normal — nadie tiene que hacer nada.

### Publicar una versión nueva

1. Sube la versión en `package.json` (`"version": "1.3.7"`, por ejemplo) y haz commit.
2. Compila el instalador de Windows:
   ```bash
   npm run dist
   ```
3. Los archivos quedan en `dist/` con espacios en el nombre, pero `latest.yml`
   (lo que lee la auto-actualización) los espera con guiones, así que hay que
   renombrarlos antes de subirlos:
   ```bash
   cd dist && cp "Curiosamente Setup 1.3.7.exe" "Curiosamente-Setup-1.3.7.exe" && cp "Curiosamente Setup 1.3.7.exe.blockmap" "Curiosamente-Setup-1.3.7.exe.blockmap"
   ```
4. Crea la versión con los tres archivos:
   ```bash
   gh release create v1.3.7 "Curiosamente-Setup-1.3.7.exe" "Curiosamente-Setup-1.3.7.exe.blockmap" "latest.yml" --repo adriaan10/curiosamente-academia --title "Curiosamente 1.3.7" --notes "Qué cambia en esta versión"
   ```
   (`npm run release` haría los pasos 2-4 de una vez, pero al subir el `.exe`
   de 80 MB se corta a media subida y deja la versión incompleta.)
5. Al publicarla, el `.dmg` de Mac se compila solo en GitHub y aparece en esa
   misma versión unos minutos después (ver más abajo). Los ordenadores con
   Windows se actualizan solos la próxima vez que abran la app.

### La versión de Mac

Un `.dmg` solo se puede compilar en un Mac, así que lo hace un ordenador
prestado de GitHub (gratis en repositorios públicos) con el flujo
`.github/workflows/compilar-mac.yml`. Se dispara solo al publicar una versión;
también se puede lanzar a mano para probar sin tocar ninguna versión:

```bash
gh workflow run compilar-mac.yml --repo adriaan10/curiosamente-academia
```

Se compila para **Apple Silicon** (Mac de 2020 en adelante) y **sin firmar**,
porque firmar exige una cuenta de Apple Developer de 99 $/año. Consecuencias:

- Al instalarlo la primera vez macOS avisa de que no puede comprobar el
  desarrollador: hay que abrirlo con **clic derecho → Abrir** y confirmar.
- **La auto-actualización no funciona en Mac.** Cada versión nueva hay que
  descargarla e instalarla a mano desde la página de versiones.

Si algún día se contrata la cuenta de Apple, **no hay que tocar código**: basta
con añadir estos secretos en *Settings → Secrets and variables → Actions* del
repositorio, y el flujo detecta que existen y pasa a firmar y notarizar solo,
con lo que la auto-actualización empieza a funcionar también en Mac:

| Secreto | Qué es |
|---|---|
| `MAC_CERT_P12` | El certificado *Developer ID Application* exportado a .p12 y codificado en base64 |
| `MAC_CERT_PASSWORD` | La contraseña que se le puso al exportar el .p12 |
| `APPLE_ID` | El correo de la cuenta de Apple Developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | Contraseña específica de app, generada en appleid.apple.com |
| `APPLE_TEAM_ID` | El identificador de equipo (10 caracteres) de la cuenta |

## Envío automático por WhatsApp (pendiente de activar)

La app ya está preparada para enviar los recibos **con el PDF adjunto**, tanto en
lote como automáticamente al marcar un recibo como pagado (justificante sellado
como PAGADO). Hasta que se completen los pasos de abajo funciona en **modo
simulación**: todo el circuito se comporta igual, pero no sale ningún mensaje real
(se ve el estado en Ajustes → Envío por WhatsApp).

### 1. Dar de alta la academia en Meta

1. Crear un *Business Portfolio* en [business.facebook.com](https://business.facebook.com).
2. Verificar la empresa (Security Center → Start Verification): hacen falta un
   documento legal de la academia y una prueba de dirección.
3. Activar la verificación en dos pasos (obligatoria).
4. Crear una *WhatsApp Business Account* y asociarle un **número de teléfono nuevo,
   dedicado solo a esto** — ese número dejará de poder usarse en la app normal de
   WhatsApp, así que no debe ser el de uso diario de la academia.

### 2. Crear las dos plantillas de mensaje

En WhatsApp Manager → Plantillas, categoría **Utilidad** (es la tarifa barata),
idioma español. Ambas con **cabecera de tipo Documento**:

| Nombre | Cuerpo |
|---|---|
| `envio_recibo` | Hola {{1}}, te enviamos el recibo de {{2}} de la Academia Curiosamente. Importe: {{3}}€. ¡Gracias! |
| `pago_confirmado` | Hola {{1}}, hemos recibido tu pago de {{2}}€ correspondiente a {{3}}. Te adjuntamos el justificante. ¡Gracias! |

El orden de los datos importa y debe coincidir exactamente con el de la tabla.

### 3. Guardar las credenciales en Supabase

En Supabase → Edge Functions → **Secrets** (nunca en el código, que es público):

| Secreto | Qué es |
|---|---|
| `WHATSAPP_TOKEN` | Token permanente de la app de Meta |
| `WHATSAPP_PHONE_ID` | *Phone Number ID* del número emisor |
| `WHATSAPP_TEMPLATE_RECIBO` | `envio_recibo` (opcional, es el valor por defecto) |
| `WHATSAPP_TEMPLATE_PAGO` | `pago_confirmado` (opcional, es el valor por defecto) |

En cuanto estén guardados, el envío pasa a real sin tocar nada más: en Ajustes el
indicador cambiará de 🟡 *En simulación* a 🟢 *Activo*.

### Coste orientativo

Las plantillas de utilidad cuestan en España unos 1,2 céntimos por mensaje. Para
~50 alumnos (recibo + confirmación de pago cada mes) son unos **1,20 €/mes**.

### Mantener Supabase activo

Un flujo de GitHub Actions (`.github/workflows/mantener-supabase-activo.yml`) hace
una consulta mínima a la base de datos cada 3 días, para que el proyecto gratuito de
Supabase nunca llegue a pausarse por inactividad, aunque nadie abra la app durante
semanas (vacaciones, por ejemplo). Si alguna vez se pausara de todos modos, no se
pierde nada: basta con entrar al panel de Supabase y pulsar "Restore".

### 3. Logo real (opcional)

El PDF lleva una recreación del logo. Para usar el logo real, guardar el archivo
como `assets/logo.png` y reiniciar la app.

## Uso diario

- **Alumnos**: buscar, filtrar por asignatura/estado, dar de alta con "+ Nuevo alumno".
  Cada profesor solo ve sus alumnos; el administrador los ve todos.
- **Recibo de un alumno**: botón "Recibo" en su fila → marcar los meses →
  el concepto ("Abril+mayo+junio"), el importe y la cantidad en letras se calculan
  solos (ajustables) → "Generar recibo PDF".
- **Recibos en lote**: botón "Recibos del mes" genera el recibo de todos los
  alumnos activos del listado de una vez.
- **Enviar por WhatsApp**: abre el chat del alumno/tutor con el mensaje escrito y
  la carpeta del PDF; solo hay que arrastrar el archivo al chat. (WhatsApp no permite
  adjuntar automáticamente desde fuera; este es el flujo más corto posible.)
- **Historial (pestaña Recibos)**: estado de cada recibo (emitido / enviado /
  pagado / pendiente) editable en la propia tabla, reabrir o regenerar el PDF,
  exportar a CSV.

## Datos y seguridad

- Los recibos PDF se guardan en `Documentos\Curiosamente\Recibos` (cambiable en Ajustes).
- Copia de seguridad automática: cada día, al abrir la app, se guarda un JSON con todos
  los datos en `Documentos\Curiosamente\Backups` (se conservan las 30 últimas).
- La base de datos está cifrada en reposo en Supabase.
- Acceso por usuario/contraseña; las reglas de seguridad (RLS) se aplican en el
  servidor: aunque alguien manipulara la app, solo podría ver sus propios alumnos.
- El recibo es un "recibí" simple sin IVA (confirmado). La referencia interna
  (R-00001…) aparece discreta en el pie del PDF para poder localizarlo.
