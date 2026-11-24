# Dependencias — BLACKBOARD-mcp

Qué hay que tener instalado para usar este MCP con un agente (Devin u otro cliente MCP por stdio).

## Requerido

| Dependencia | Versión | Para qué | Cómo instalar |
|---|---|---|---|
| Node.js | 18+ (20 recomendado) | Runtime del servidor (ESM) | https://nodejs.org |
| npm | incluido con Node | Instalar deps y compilar | `npm install && npm run build` |
| Google Chrome **o** Chromium | cualquiera reciente | El tool `login` abre una ventana real para el SSO "Con mi UP" | Chrome normal; o Chromium + `BLACKBOARD_BROWSER_CHANNEL=chromium` |
| Un escritorio / display | — | La ventana de login es `headless: false`, necesita GUI (en Linux, `DISPLAY`/`XAUTHORITY`) | Cualquier entorno gráfico |

Paquetes npm (se instalan con `npm install`, ver `package.json`):
- `@modelcontextprotocol/sdk` — servidor MCP
- `playwright` — login por navegador + sesión HTTP autenticada
- `zod` — schemas de los tools
- `unpdf`, `jszip` — leer texto de PDFs y manejar archivos
- `typescript` + `@types/node` — solo para compilar (`npm run build`)

## NO hace falta

- Credenciales en texto plano: el login se hace manualmente una vez en la ventana de Chrome (SSO "Con mi UP"); la sesión queda guardada en `~/.blackboard-mcp/session.json` (no se comparte: cada usuario genera la suya).
- `playwright install`: no hace falta si hay un Chrome/Chromium del sistema — el código lo lanza por `channel`, no usa los browsers que descarga Playwright.

## Variables de entorno opcionales

| Variable | Default | Cuándo cambiarla |
|---|---|---|
| `BLACKBOARD_BROWSER_CHANNEL` | `chrome` | `chromium` si no hay Chrome (requisito en Devin/Linux sin Chrome) |
| `BLACKBOARD_BASE_URL` | `https://palermo.blackboard.com` | Otra instancia Blackboard Ultra |
| `BLACKBOARD_LOGIN_URL` | derivada de BASE_URL | SSO distinto |
| `BLACKBOARD_STATE_FILE` | `~/.blackboard-mcp/session.json` | Cambiar dónde se guarda la sesión |

## Instalación rápida

```bash
unzip BLACKBOARD-mcp.zip && cd BLACKBOARD-mcp
npm install
npm run build          # genera dist/
```

Registrar el servidor en tu cliente MCP apuntando a `node dist/index.js` (o `npm start`).
Luego llamar al tool `login`, entrar con "Con mi UP" en la ventana que se abre, y ya queda la sesión para los demás tools.

## Privacidad

No compartas `~/.blackboard-mcp/session.json` ni la carpeta `captures/` (si existe): contienen cookies y datos del usuario.
