# Simulador de Voo Arcade

Simulador de voo arcade no navegador usando PlayCanvas 2.24, Vite e TypeScript. Voe sobre uma cidade procedural com terreno, mar e montanhas geradas por ruído determinístico.

## Requisitos
- Node 20+

## Como rodar

```bash
npm install
npm run dev
```
Abra http://localhost:5173 no Chrome.

## Build de produção
```bash
npm run build
```

## Testes
```bash
npm test
```

## Controles

| Tecla | Ação |
|-------|------|
| W / S | Arfagem (nariz para cima / baixo) |
| A / D | Rolagem (inclinação esquerda / direita) |
| Q / E | Leme (guinada esquerda / direita) |
| Shift / Ctrl | Acelerador (+ / −) |
| C / V | Alternar câmera (atrás / de cima / cabine) |
| R | Reiniciar voo |

## Estrutura de pastas (src/flight/)

- `noise.ts` — Ruído de valor 2D, FBM, RNG determinístico, `clamp01`, `smoothstep`
- `types.ts` — Contrato compartilhado: `FlightState`, `FlightContext`, `FlightModule`, `CameraMode`, `SPAWN`
- `world.ts` — Geração de terreno, mar, cidade, céu, nuvens; `groundAt(x, z)` para colisão
- `airplane.ts` — Modelo do avião (caixas), hélice, pontas das asas para rastros
- `flight.ts` — Controlador de voo (arcade: rolagem vira, estol leve, respawn 2 s)
- `cameras.ts` — Rig de câmera: perseguição, topo, cabine (troca com C/V)
- `cockpit.ts` — Painel 2D: horizonte artificial, velocímetro, altímetro, bússola, acelerador
- `hud.ts` — HUD HTML: velocidade, altitude, throttle, câmera atual, barra de atalhos