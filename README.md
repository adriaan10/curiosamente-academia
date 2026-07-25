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

1. Sube la versión en `package.json` (`"version": "1.0.1"`, por ejemplo).
2. Ejecuta:
   ```bash
   npm run release
   ```
   Esto compila, genera el instalador y sube un borrador de "release" a GitHub.
3. Publica el borrador (quitarle "Draft"), desde la web de GitHub o con:
   ```bash
   gh release edit vX.Y.Z --repo adriaan10/curiosamente-academia --draft=false
   ```
4. En cuanto está publicado, todos los ordenadores de la academia lo detectan solos
   la próxima vez que abran la app.

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
