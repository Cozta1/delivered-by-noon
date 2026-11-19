# Horizonte Dourado — Mundo Aberto de Veículos

Jogo 3D de mundo aberto de veículos no navegador com **PlayCanvas 2.24**, Vite e TypeScript. Comece dirigindo na cidade ao entardecer, saia a pé para explorar e entre em outros carros, no helicóptero no heliponto do centro ou no **A-29** na pista do aeroporto perto da praia.

Inclui modelos 3D originais feitos no Blender (personagem, 3 carros, helicóptero e A-29), física de voo baseada no JSBSim (LGPL-2.1), minimapa, tela inicial com câmera orbital, menu de pausa, opções persistidas em `localStorage` e áudio/trilha 100% procedurais (Web Audio API).

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

Para publicar e montar a cena no PlayCanvas Editor online, consulte [docs/editor.md](docs/editor.md).

## Controles

| Entrada | Ação |
|---------|------|
| E | Entrar ou sair de veículo próximo (carro, helicóptero ou A-29) |
| W / A / S / D | Andar (a pé), dirigir (carro) ou pilotar (aeronaves) |
| Espaço | Freio de mão (carro) ou pular (a pé) |
| Mouse + clique | Girar câmera (a pé/carro) ou mirar (aeronaves) |
| Esc / P | Pausar / retomar (soltar o pointer lock também pausa) |
| M | Alternar entre controle por Mouse e Teclado (aeronaves) |
| Q / E | Leme / pedais (aeronaves) |
| Shift / Ctrl | Acelerador / coletivo (+ / − em aeronaves) |
| F | Ligar / desligar fumaça branca na cauda (A-29) |
| C / V | Alternar câmeras disponíveis para o veículo atual |
| R | Reiniciar veículo atual |

## Estrutura de pastas (`src/flight/`)

- `types.ts` — Contrato compartilhado (`FlightState`, `VehicleKind`, `VehicleSpawn`, `FlightContext`, `FlightModule`)
- `game.ts` — Loop principal, estados (`title` / `playing` / `paused`), Modo cena, qualidade gráfica e animações de rodas/rotores
- `world.ts` e `world-data.ts` — Terreno, mar, cidade, aeroporto/pista, heliponto, céu e nuvens; física de colisão
- `vehicles.ts`, `car.ts`, `foot.ts`, `flight.ts` e `fdm/` — Gerenciador de veículos, carro, personagem a pé e voo JSBSim (LGPL-2.1)
- `models/` — Carregamento de GLBs + fallbacks procedurais (`index.ts`, `glb.ts`), [airplane.ts](src/flight/airplane.ts) e [helicopter.ts](src/flight/helicopter.ts)
- `cameras.ts` — Câmeras por veículo (ombro a pé, chase baixa de carro, perseguição/topo/cabine em aeronaves)
- `cockpit.ts` — Painel 2D de instrumentos (visível apenas em aeronaves na câmera de cabine)
- `hud.ts` — HUD contextual por veículo, velocímetro de carro, aviso de entrada (`E`), minimapa 2D e miras
- `smoke.ts` — Fumaça acrobática branca do A-29 com pool fixo de partículas
- `ui/` — Opções salvas em `localStorage` (`settings.ts`) e menus (`menus.ts`)
- `audio/sound.ts` — Áudio procedural Web Audio API (motor de carro, passos, rotor de helicóptero, turboélice, vento sem emenda, porta, estol, batida e música ambiente)
