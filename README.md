# Horizonte Dourado — Simulador de Voo (A-29)

Simulador de voo no navegador com **PlayCanvas 2.24**, Vite e TypeScript, modelado no espírito do A-29 Super Tucano ao entardecer sobre terreno, cidade, mar e montanhas procedurais. Inclui tela inicial com câmera orbital, menu de pausa, opções persistidas em `localStorage`, áudio e trilha 100% procedurais (Web Audio API), fumaça acrobática e publicação no PlayCanvas Editor.

## Requisitos
- Node 20+ (recomendado Node 24 para publicação automática no Editor)

## Como rodar

```bash
npm install
npm run dev
```
Abra http://localhost:5173 no Chrome.

## Build, Editor e testes
```bash
npm run typecheck
npm test
npm run build
npm run build:editor
```

Para publicar no PlayCanvas Editor online, consulte [docs/editor.md](docs/editor.md).

## Controles

| Entrada | Ação |
|---------|------|
| Mouse | Move a mira livremente (modo mouse) |
| Clique esquerdo | Trava o ponteiro para mirar |
| Esc / P | Pausar / retomar (soltar o pointer lock também pausa) |
| M | Alternar entre controle por Mouse e Teclado |
| W / S ou ↑ / ↓ | Arfagem (nariz para baixo / cima) |
| A / D ou ← / → | Rolagem (inclinação esquerda / direita) |
| Q / E | Leme (guinada esquerda / direita) |
| Shift / Ctrl | Acelerador (+ / −) |
| F | Ligar / desligar fumaça branca na cauda |
| C / V | Alternar câmera (ATRÁS / DE CIMA / CABINE) |
| R | Reiniciar voo |

## Estrutura de pastas (`src/flight/`)

- `types.ts` — Contrato compartilhado (`FlightState`, `FlightContext`, `FlightModule`, `CameraMode`, `SPAWN`)
- `game.ts` — Loop principal, estados (`title` / `playing` / `paused`), qualidade gráfica e integração dos módulos
- `world.ts` — Terreno, mar, cidade, céu e nuvens procedurais; `groundAt(x, z)`
- `airplane.ts` — Modelo A-29 (GLB do Blender com fallback procedural), hélice de 5 pás e `hitbox`
- `flight.ts` e `fdm/` — Dinâmica de voo baseada no JSBSim (LGPL-2.1, JSBSim-Team) e instrutor de mira
- `cameras.ts` — Câmeras perseguição, topo e cabine (sensibilidade e inversão de eixo Y pelas opções)
- `cockpit.ts` — Painel 2D da cabine (velocímetro, horizonte, altímetro, bússola, variômetro, acelerador)
- `hud.ts` — HUD HTML (telemetria, miras, indicador de fumaça e atalhos; respeita opção de exibir HUD)
- `smoke.ts` — Fumaça acrobática branca com pool fixo de partículas
- `ui/settings.ts` — Opções salvas em `localStorage` e estado de execução compartilhado
- `ui/menus.ts` — Tela inicial, menu de pausa, opções, controles e créditos
- `audio/sound.ts` — Motor turboélice, vento, estol, batida, cliques e música ambiente procedural (Web Audio API)
