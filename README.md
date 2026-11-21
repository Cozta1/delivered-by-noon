# Delivered by Midnight

**Entregue tudo antes do relógio bater meia-noite — ou a noite engole suas encomendas.**

---

## Descrição geral

**Enredo:** Você é um entregador que começa à meia-noite e tem até a meia-noite seguinte (24 horas no relógio do jogo) para completar todas as entregas. A progressão é de veículos cada vez mais malucos: carro comum → carro tunado → helicóptero → avião de ataque leve A-29 Super Tucano. Cada veículo já traz suas encomendas ao entrar nele; a última entrega do estágio leva o jogador ao próximo veículo.

**Objetivos:** Entregar todas as encomendas antes das 24:00. O relógio no HUD mostra o tempo restante (0 = 00:00, 1440 = 24:00). O ciclo de dia/noite acompanha o relógio. **Vitória:** todas as entregas concluídas antes do prazo. **Derrota:** relógio chega a 24:00 com encomendas pendentes. Pontuação por entrega feita; bônus por tempo restante.

---

## Ferramenta utilizada

- **PlayCanvas** (Editor online + engine 2.x)
- **TypeScript** + **Vite** para build local e script ESM único
- Modelos 3D feitos no **Blender** (exportados GLB)

---

## Instalação e execução

**Requisitos:** Node 20+

```bash
npm install
npm run dev        # abre http://localhost:5173 no Chrome
npm run build      # build de produção
npm test           # roda testes (vitest)
```

**Como jogar no Editor do PlayCanvas:** veja o guia completo em [`docs/editor.md`](docs/editor.md) — resume: `npm run build:editor` gera `dist-editor/flight-sim.mjs`; publique no Editor via API (`npm run publicar:editor`) ou upload manual; monte a cena com o snippet `scripts/montar-cena-editor.js` no Console (F12); clique **Launch**.

---

## Controles

### Gerais
| Tecla | Ação |
|-------|------|
| **E** | Entrar / sair de veículo próximo |
| **C** / **V** | Alternar câmera (atrás / de cima / cabine) |
| **M** | Alternar Mouse / Teclado (aeronaves) |
| **Esc** / **P** | Pausar / menu de pausa |

### A pé
| Tecla | Ação |
|-------|------|
| **W / A / S / D** | Andar |
| **Espaço** | Pular |
| **Mouse** | Girar câmera |
| **Clique esquerdo** | Travar/soltar ponteiro |

### Carro / Carro tunado
| Tecla | Ação |
|-------|------|
| **W / A / S / D** | Dirigir |
| **Espaço** | Freio de mão |
| **Mouse** | Girar câmera |

### Helicóptero
| Tecla | Ação |
|-------|------|
| **W / S** | Coletivo (subir / descer) |
| **A / D** | Guinada (leme) |
| **Mouse** | Mira (inclinação do rotor) |
| **Q / E** | Leme / pedais |
| **Shift / Ctrl** | Acelerador (+ / −) |

### A-29 Super Tucano
| Tecla | Ação |
|-------|------|
| **W / S** | Arfagem (nariz cima / baixo) |
| **A / D** | Rolagem (inclinação) |
| **Q / E** | Leme |
| **Shift / Ctrl** | Acelerador (+ / −) |
| **Espaço** | Lançamento aéreo (air-drop) |
| **F** | Liga / desliga fumaça na cauda |
| **R** | Reiniciar veículo atual |

---

## Capturas de tela e GIFs

*Imagens serão adicionadas após a entrega.*

![Tela inicial](docs/imagens/tela-inicial.png)
![Jogabilidade — carro](docs/imagens/jogabilidade-carro.png)
![Jogabilidade — helicóptero](docs/imagens/jogabilidade-helicoptero.png)
![Jogabilidade — A-29](docs/imagens/jogabilidade-a29.png)
![HUD e missão](docs/imagens/hud-missao.png)

---

## Versão jogável

**Link jogável:** (será adicionado)

---

## Estrutura do projeto

- `src/main.ts` — Ponto de entrada, inicializa app PlayCanvas e módulos
- `src/flight/types.ts` — Contrato compartilhado: `FlightState`, `MissionState`, `VehicleKind`, `Stage`, `FlightContext`
- `src/flight/noise.ts` — Ruído determinístico (valueNoise, fbm, rng, clamp01, smoothstep)
- `src/flight/world.ts` — Terreno procedural, mar, cidade, céu, nuvens; `groundAt(x, z)`
- `src/flight/world-data.ts` — Dados estáticos do mundo (spawns de veículos, pontos de entrega)
- `src/flight/vehicles.ts` — Gerenciador de veículos (spawn, enter/exit, troca de controle)
- `src/flight/car.ts` — Física arcade de carro (com variante tunada)
- `src/flight/foot.ts` — Movimento a pé (andar, pular, câmera)
- `src/flight/helicopter.ts` — Helicóptero: coletivo, cíclico, mira por mouse
- `src/flight/airplane.ts` — Modelo procedural do A-29 (caixas, hélice, pontas de asa)
- `src/flight/flight.ts` — Controlador de voo do A-29 (arcade + FDM híbrido)
- `src/flight/cameras.ts` — Rig de câmera: perseguição, topo, cabine por veículo
- `src/flight/cockpit.ts` — Painel 2D (horizonte artificial, velocímetro, altímetro, bússola, throttle)
- `src/flight/hud.ts` — HUD HTML: velocidade, altitude, throttle, relógio, entregas, score, atalhos
- `src/flight/game.ts` — Orquestração: missão, spawns, progressão de estágios, vitória/derrota
- `src/flight/ui/menus.ts` — Menus: pausa, intro, vitória, derrota, configurações
- `src/flight/ui/settings.ts` — Configurações persistidas (sensibilidade, inversão, etc.)
- `src/flight/audio/sound.ts` — Motor, ambiente, UI, fumaça
- `src/flight/smoke.ts` — Sistema de partículas de fumaça (A-29)
- `src/flight/fdm/` — Flight Dynamics Model derivado do JSBSim (PC-7 → A-29)
  - `model.ts` — Dinâmica de corpo rígido 6-DOF, atmosfera ISA, assistência arcade
  - `instructor.ts` — Guia de mira por mouse (horizontal + vertical)
  - `controller.ts` — Mistura teclado/mouse, resposta em taxa
  - `table.ts`, `atmosphere.ts` — Tabelas aerodinâmicas e atmosfera
  - `aircraft-pc7.json`, `aircraft-a29.json` — Dados do avião (polares, massa, inércia, motor)
  - `ground.ts`, `heli.ts` — Solo e helicóptero (FDM simplificado)
  - `LICENSE-JSBSim.txt` — Licença LGPL-2.1 do JSBSim
- `src/flight/models/` — Carregamento GLB (A-29, mundo, veículos)
- `src/editor/` — Scripts de build para o PlayCanvas Editor (ESM externo)
- `public/models/` — Assets GLB exportados do Blender
- `scripts/` — Scripts de automação (publicar no Editor, montar cena, exportar mundo)
- `docs/editor.md` — Guia de publicação no PlayCanvas Editor
- `brain/` — Decisões, visão, roadmap, orquestração do projeto

---

## Integrantes

- João Victor da Costa
- Gabriel Monteiro
- Rafael Lima Henriques
- Lucas Tostes

---

## Créditos e licenças

A física de voo (FDM) foi portada e adaptada do **JSBSim** (LGPL-2.1, *JSBSim-Team*). Os arquivos derivados estão em `src/flight/fdm/` e a licença original em `src/flight/fdm/LICENSE-JSBSim.txt`. Nenhum código do FlightGear foi utilizado; é um subconjunto educacional com assistência arcade, não o motor JSBSim completo nem uma simulação validada do A-29.

- **PlayCanvas** — Engine 3D web
- **Blender** — Modelagem 3D
