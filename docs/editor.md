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

## 3. Publicação automática (via REST API)

Você pode enviar `dist-editor/flight-sim.mjs` e `public/models/a29.glb` automaticamente para o projeto no PlayCanvas Editor sem fazer upload manual:

1. Gere um **API Access Token** na sua conta em [playcanvas.com/account](https://playcanvas.com/account).
2. Crie (ou edite) o arquivo `.env` na raiz do projeto (ignorado pelo Git) com:
   ```env
   PLAYCANVAS_API_TOKEN=seu_token_aqui
   PLAYCANVAS_PROJECT_ID=1606932
   # Opcional: define um branch específico (padrão: branch principal do projeto)
   # PLAYCANVAS_BRANCH_ID=
   ```
3. Teste a conexão sem alterar nada no projeto remoto (somente leitura):
   ```bash
   npm run publicar:editor:teste
   ```
4. Compile e publique (cria ou atualiza `flight-sim.mjs` e `a29.glb` com `preload` ligado):
   ```bash
   npm run publicar:editor
   ```

### Alternativa manual (upload pelo navegador)

1. No painel **Assets** (parte inferior), clique em **+** → **Upload** (ou arraste os arquivos diretamente para a pasta raiz de Assets).
2. Envie o script `dist-editor/flight-sim.mjs` e aguarde o processamento: o Editor reconhecerá automaticamente o script ESM **`flightSim`** (`FlightSim`).
3. Envie também o modelo 3D `public/models/a29.glb` para a pasta **Assets** (o Editor criará automaticamente um asset container chamado **`a29.glb`**).
   > **Nota:** Se `a29.glb` não for enviado, o simulador usa automaticamente o modelo procedural de fallback do A-29.

## 4. Montar a cena visível no Viewport do Editor (Modo cena)

Para que o mundo, o A-29, a câmera e o sol apareçam **montados na Hierarchy e visíveis no Viewport** do PlayCanvas Editor (em vez de serem criados apenas em tempo de execução):

1. **Publique os assets** no projeto do Editor:
   ```bash
   npm run publicar:editor
   ```
   (Envie também os arquivos `public/models/mundo-*.glb` nos Assets do Editor se ainda não estiverem lá.)
2. **Abra a cena do projeto** no navegador: `https://playcanvas.com/editor/project/1606932` (aguarde terminar de carregar).
3. Pressione **F12** para abrir o DevTools e clique na aba **Console**.
4. Copie todo o conteúdo de `scripts/montar-cena-editor.js`, **cole no Console** e pressione **Enter**.
   - O snippet usa apenas a Editor API oficial (`editor`), é 100% local e pode ser executado novamente sem duplicar entidades.
   - Ele cria/atualiza `Jogo` (com o script `simuladorVoo`), `Mundo` (filhos de `mundo-*.glb`, incluindo `mundo-aeroporto.glb`), os veículos estacionados (`A29` na pista, `Heli` no heliponto, `Carro_Inicial`, `Carro_1..5` e `Personagem`), `CameraJogo` e `Sol`, desativa `Camera`/`Light` padrão e entidades/scripts antigos (`Player`, `Ground`, `Plane`, `playerMovement`, `cameraFollow`, `gunController`) e tenta habilitar **Settings → Input → Keyboard**.
   - Compatível tanto com o formato novo (`template`/`render`) quanto com o formato legado (`model`, quando `useModelV2` está desativado no projeto). Ao final, o Console imprime um resumo diagnóstico do que foi montado.
5. Confira na **Hierarchy** as cinco entidades criadas (selecione `A29` e aperte **F** para focar o avião no Viewport).
6. Clique em **Launch**: o simulador detecta automaticamente `Mundo`, `A29`, `CameraJogo` e `Sol` na cena e os utiliza sem criar duplicatas (mantendo a colisão lógica do terreno/cidade).

> **Nota:** Sem a cena montada (ou se alguma dessas entidades faltar), o script continua funcionando normalmente criando o que faltar em tempo de execução.
>
> **Formato novo de GLB (opcional):** Se preferir trabalhar com hierarquia completa e templates no Editor (para ver o nó `Prop` separado na Hierarchy), ative em **Settings → Asset Tasks → Import Hierarchy** / **Create Templates** (`useModelV2`), reimporte `a29.glb` e os `mundo-*.glb` (botão direito → *Re-import*) e execute o snippet novamente.

### Como reverter a cena montada

- **Imediatamente após colar o snippet:** pressione **Ctrl + Z** no Editor (as operações ficam no histórico de desfazer) ou restaure um checkpoint em **Version Control**.
- **Manualmente a qualquer momento:** apague as entidades `Jogo`, `Mundo`, `A29`, `CameraJogo` e `Sol` na **Hierarchy** e marque novamente **Enabled** em `Camera`, `Light` e nas entidades antigas (`Player`, `Ground`, `Plane`) pelo **Inspector**.

### Alternativa manual (sem usar o snippet)

1. Desative no **Inspector** as entidades antigas (`Player`, `Ground`, `Plane`) e scripts antigos (`playerMovement`, `cameraFollow`, `gunController`).
2. Selecione **`Root`** (ou crie uma entidade vazia `Jogo`), clique em **Add Component → Script** e escolha **`simuladorVoo`** (ou **`flightSim`**).

## 5. Executar (Launch)

1. Clique no botão **Launch** (canto superior direito do Editor) para abrir a aba de execução.
2. Clique na tela do jogo caso ela ainda não tenha foco de teclado e comece a voar.

## 6. Controles

| Entrada | Ação |
|---|---|
| **E** | Entrar / sair de um veículo próximo (carro, helicóptero ou A-29) |
| **W / A / S / D** | Andar (a pé), dirigir (carro) ou pilotar (aeronaves) |
| **Espaço** | Freio de mão (carro) ou pular (a pé) |
| **Mouse** | Gira a câmera (a pé/carro) ou move a mira (aeronaves) |
| **Clique esquerdo** | Trava o ponteiro para girar a câmera / mirar (**Esc** solta e pausa) |
| **Esc** ou **P** | Pausa / abre ou fecha o menu de pausa (perder o pointer lock também pausa) |
| **M** | Alterna entre modo **Mouse** e **Teclado** (aeronaves) |
| **Q / E** | Leme / pedais em aeronaves |
| **Shift / Ctrl** | Acelerador / coletivo (+ / − em aeronaves) |
| **F** | Liga / desliga a fumaça branca na cauda do A-29 |
| **C** ou **V** | Alternar câmeras disponíveis para o veículo atual |
| **R** | Reiniciar veículo atual |

## 7. Como atualizar o script depois

Sempre que alterar o código-fonte do simulador:

1. Rode `npm run build:editor` localmente para atualizar `dist-editor/flight-sim.mjs`.
2. No painel **Assets** do PlayCanvas Editor, faça o upload do novo `flight-sim.mjs` sobre a mesma pasta (ou clique com o botão direito no asset `flight-sim.mjs` → **Re-import / Upload** para substituir mantendo a referência no componente Script).
3. Recarregue a aba de **Launch** para testar a nova versão.
