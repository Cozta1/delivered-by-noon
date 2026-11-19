# Como publicar no Editor online do PlayCanvas

Este guia explica como levar o simulador de voo compilado em arquivo único (`dist-editor/flight-sim.mjs`) para um projeto no **PlayCanvas Editor** (`playcanvas.com`) usando scripts ESM e engine **2.x**.

## 1. Gerar o arquivo do Editor (localmente)

No diretório do projeto, gere o módulo ESM:

```bash
npm run build:editor
```

Isso cria `dist-editor/flight-sim.mjs` (com o CSS embutido e `playcanvas` como dependência externa fornecida pelo Editor).

## 2. Criar e configurar o projeto no Editor online

1. Acesse [playcanvas.com](https://playcanvas.com) e crie um **projeto vazio** (*Blank Project*).
2. Abra **Settings** (ícone de engrenagem no canto inferior esquerdo).
3. Na seção **Engine**, selecione a versão **2.x** mais recente disponível.
4. Em **Settings → Input → Keyboard**, confirme que o teclado está habilitado (já vem ativado por padrão; se estiver desativado, o script exibirá um aviso na tela e não iniciará os controles).

## 3. Enviar o script `flight-sim.mjs`

1. No painel **Assets** (parte inferior), clique em **+** → **Upload** (ou arraste o arquivo diretamente para a pasta raiz de Assets).
2. Selecione o arquivo `dist-editor/flight-sim.mjs`.
3. Aguarde o processamento: o Editor reconhecerá automaticamente o script ESM **`flightSim`** (`FlightSim`).

## 4. Anexar o script à cena

1. Na hierarquia da cena (**Hierarchy**, painel à esquerda), selecione a entidade **`Root`** (ou crie uma nova entidade vazia, por exemplo `FlightSim`).
2. No **Inspector** (painel à direita), clique em **Add Component** → **Script**.
3. No componente Script, clique em **Add Script** e escolha **`flightSim`**.
   > **Nota:** A cena padrão do Editor já traz uma `Camera` e uma `Light`. Não é necessário removê-las manualmente: o script desativa automaticamente câmeras e luzes pré-existentes ao iniciar e cria o mundo, o avião, o sol, a câmera e o HUD/cabine.

## 5. Executar (Launch)

1. Clique no botão **Launch** (canto superior direito do Editor) para abrir a aba de execução.
2. Clique na tela do jogo caso ela ainda não tenha foco de teclado e comece a voar.

## 6. Controles

| Entrada | Ação |
|---|---|
| **Mouse** | Move a mira livremente (no modo mouse, o avião pilota até ela) |
| **Clique esquerdo** | Trava o ponteiro para mirar (**Esc** solta) |
| **M** | Alterna entre modo **Mouse** e **Teclado** |
| **W / S** ou **↑ / ↓** | Arfagem (baixar / subir o nariz; ajuste fino no modo mouse) |
| **A / D** ou **← / →** | Rolagem (inclinar asas e curvar; ajuste fino no modo mouse) |
| **Q / E** | Leme (guinada esquerda / direita) |
| **Shift / Ctrl** | Acelerador (+ / −) |
| **C** ou **V** | Alternar câmera (**ATRÁS**, **DE CIMA**, **CABINE**) |
| **R** | Reiniciar voo no ponto inicial |

## 7. Como atualizar o script depois

Sempre que alterar o código-fonte do simulador:

1. Rode `npm run build:editor` localmente para atualizar `dist-editor/flight-sim.mjs`.
2. No painel **Assets** do PlayCanvas Editor, faça o upload do novo `flight-sim.mjs` sobre a mesma pasta (ou clique com o botão direito no asset `flight-sim.mjs` → **Re-import / Upload** para substituir mantendo a referência no componente Script).
3. Recarregue a aba de **Launch** para testar a nova versão.
