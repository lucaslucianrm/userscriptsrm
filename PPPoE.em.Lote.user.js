// ==UserScript==
// @name         IXC - Consulta PPPoE em Lote
// @namespace    rolimnet
// @version      1.0
// @description  Consulta PPPoE em lotes, facilidade para verificar migrações
// @author       Lucas Lucian
// @match        https://ixc.rolimnet.com.br/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @downloadURL  https://github.com/lucaslucianrm/userscriptsrm/raw/refs/heads/main/PPPoE.em.Lote.user.js
// @updateURL    https://github.com/lucaslucianrm/userscriptsrm/raw/refs/heads/main/PPPoE.em.Lote.user.js
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window) {
        return;
    }
    const VERSAO = GM_info.script.version;
    const LIMITE_ITENS = 100;
    const INTERVALO_MS = 2000;

    const STATUS_ACESSO = {
        A: 'Ativo',
        D: 'Desativado',
        CM: 'Bloqueio Manual',
        CA: 'Bloqueio Automático',
        FA: 'Financeiro em atraso',
        AA: 'Aguardando Assinatura'
    };

    if (!document.getElementById('pppoe-style')) {
        adicionarEstilos();
    }
    GM_registerMenuCommand('Consulta PPPoE Lote Geral', abrirJanela);
    setTimeout(adicionarMenuIXC, 1000);
    setInterval(adicionarMenuIXC, 3000);

    function abrirJanela() {

        document
            .querySelectorAll('#pppoe-consulta-modal')
            .forEach(el => el.remove());

        const modal = document.createElement('div');

        modal.id = 'pppoe-consulta-modal';

        modal.innerHTML = `
            <div id="pppoe-box">

                <div id="pppoe-header">
                    <span>Consulta PPPoE em Lote Geral - v${VERSAO}</span>
                    <button id="pppoe-fechar">✖</button>
                </div>

                <textarea
                    id="pppoe-lista"
                    placeholder="Informe um login por linha (máximo ${LIMITE_ITENS})"
                ></textarea>

                <div id="pppoe-info">

    <span id="pppoe-contador">
        0 / ${LIMITE_ITENS} itens
    </span>

    <span id="pppoe-tempo">
        Tempo estimado: 0s
    </span>

</div>

                <div id="pppoe-toolbar">

                    <button id="pppoe-verificar">
                        Verificar
                    </button>

<button id="pppoe-copiar" disabled>
    Copiar para Excel
</button>

<button id="pppoe-exportar" disabled>
    Exportar CSV
</button>

                    <span id="pppoe-status">
                        Aguardando...
                    </span>

                </div>

                <div id="pppoe-resumo">
                    Online: 0 | Offline: 0 | Não encontrado: 0
                </div>

                <div id="pppoe-tabela-wrapper">

                    <table id="pppoe-tabela">

                        <thead>
                            <tr>
                                <th>Login Informado</th>
                                <th>Online</th>
                                <th>Status do Acesso</th>
                            </tr>
                        </thead>

                        <tbody></tbody>

                    </table>

                </div>

            </div>
        `;

        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });

        document.getElementById('pppoe-fechar')
            .addEventListener('click', () => modal.remove());

        document.getElementById('pppoe-verificar')
            .addEventListener('click', iniciarConsulta);

        document.getElementById('pppoe-copiar')
            .addEventListener('click', copiarTabela);
        document.getElementById('pppoe-exportar')
            .addEventListener('click', exportarCSV);

        document.getElementById('pppoe-lista')
            .addEventListener('input', atualizarContador);

        atualizarContador();
    }

    function adicionarMenuIXC() {

        if (document.getElementById('menu_item_pppoe_lote')) {
            return;
        }

        const plataformaVoip =
              [...document.querySelectorAll('.submenu_title a')]
        .find(el =>
              el.textContent.trim() === 'Plataforma Voip'
             );

        if (!plataformaVoip) {
            return;
        }

        const menuPai =
              plataformaVoip.closest('.menu_p');

        const submenuVoip =
              menuPai?.nextElementSibling;

        if (!submenuVoip) {
            return;
        }

        const wrapper =
              document.createElement('div');

        wrapper.innerHTML = `
        <div
            id="menu_item_pppoe_lote"
            class="menu_p menu_fechado">

            <div class="submenu_title">
                <a style="cursor:pointer;">
                    Consulta PPPoE em Lote Geral
                </a>
            </div>

        </div>
    `;

        submenuVoip.after(wrapper);

        wrapper
            .querySelector('a')
            .addEventListener('click', abrirJanela);
    }

    function adicionarEstilos() {

        const style = document.createElement('style');

        style.id = 'pppoe-style';

        style.textContent = `

            #pppoe-consulta-modal{
                position:fixed;
                inset:0;
                background:rgba(0,0,0,.45);
                z-index:2147483647;

                display:flex;
                justify-content:center;
                align-items:center;
            }

            #pppoe-box{
                width:min(1400px,95vw);
                height:min(850px,90vh);

                background:#fff;
                color:#000;

                border-radius:8px;
                box-shadow:0 0 30px rgba(0,0,0,.35);

                padding:15px;
                box-sizing:border-box;

                display:flex;
                flex-direction:column;
            }

            #pppoe-header{
                display:flex;
                justify-content:space-between;
                align-items:center;
                margin-bottom:10px;
                font-size:18px;
                font-weight:bold;
            }

            #pppoe-fechar{
                cursor:pointer;
            }

            #pppoe-lista{
                width:100%;
                height:220px;
                resize:none;
                padding:8px;
                box-sizing:border-box;
                font-family:Consolas, monospace;
            }

#pppoe-info{
    margin-top:5px;
    margin-bottom:10px;
    font-size:12px;
    color:#666;

    display:flex;
    justify-content:space-between;
}

            #pppoe-toolbar{
                display:flex;
                align-items:center;
                gap:10px;
                margin-bottom:10px;
            }

            #pppoe-status{
                margin-left:auto;
                font-weight:bold;
            }

            #pppoe-resumo{
                margin-bottom:10px;
                font-weight:bold;
            }

            #pppoe-tabela-wrapper{
                flex:1;
                overflow:auto;
                border:1px solid #ddd;
            }

            #pppoe-tabela{
                width:100%;
                border-collapse:collapse;
                table-layout:fixed;
            }

            #pppoe-tabela th,
            #pppoe-tabela td{
                border:1px solid #ddd;
                padding:8px;
                color:#000;
            }

#pppoe-tabela th{
    background:#e8e8e8;
                position:sticky;
                top:0;
                z-index:1;
            }

            #pppoe-tabela th:nth-child(1),
            #pppoe-tabela td:nth-child(1){
                width:60%;
            }

            #pppoe-tabela th:nth-child(2),
            #pppoe-tabela td:nth-child(2){
                width:15%;
                text-align:center;
            }

            #pppoe-tabela th:nth-child(3),
            #pppoe-tabela td:nth-child(3){
                width:25%;
            }

            .status-online{
                background:#dff0d8 !important;
                color:#008000 !important;
                font-weight:bold;
            }

            .status-offline{
                background:#f2dede !important;
                color:#cc0000 !important;
                font-weight:bold;
            }

            .status-nao-encontrado{
                background:#fcf8e3 !important;
                color:#a67c00 !important;
                font-weight:bold;
            }
            .status-multiplos{
    background:#d9edf7 !important;
    color:#31708f !important;
    font-weight:bold;
}
        `;

        document.head.appendChild(style);
    }

    function atualizarContador() {

        const textarea =
              document.getElementById('pppoe-lista');

        const contador =
              document.getElementById('pppoe-contador');

        const tempo =
              document.getElementById('pppoe-tempo');

        const total = textarea.value
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean)
        .length;

        contador.textContent =
            `${total} / ${LIMITE_ITENS} itens`;

        tempo.textContent =
            `Tempo estimado: ${total * 2}s`;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function iniciarConsulta() {
        const btn =
              document.getElementById('pppoe-verificar');

        const textarea =
              document.getElementById('pppoe-lista');

        const tbody =
              document.querySelector('#pppoe-tabela tbody');

        const status =
              document.getElementById('pppoe-status');

        const resumo =
              document.getElementById('pppoe-resumo');

        const itens = textarea.value
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);

        if (!itens.length) {
            alert('Informe pelo menos um login.');
            return;
        }

        if (itens.length > LIMITE_ITENS) {
            alert(
                `Limite máximo de ${LIMITE_ITENS} itens.\n\n` +
                `Quantidade informada: ${itens.length}`
            );
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Consultando...';
        tbody.innerHTML = '';
        document.getElementById('pppoe-copiar')
            .disabled = true;

        document.getElementById('pppoe-exportar')
            .disabled = true;

        let online = 0;
        let offline = 0;
        let multiplos = 0;
        let naoEncontrado = 0;

        try {

            for (let i = 0; i < itens.length; i++) {

                const login = itens[i];

                status.textContent =
                    `Consultando ${i + 1}/${itens.length}`;

                try {

                    const response = await fetch(
                        `/dashboard/consulta.php?filtro=todos&consulta=${encodeURIComponent(login)}&crm=S`,
                        {
                            credentials: 'same-origin'
                        }
                    );

                    const dados = await response.json();

                    const resultado =
                          tratarResultado(login, dados);

                    if (resultado.online === 'Online') {
                        online++;
                    }
                    else if (resultado.online === 'Offline') {
                        offline++;
                    }
                    else if (resultado.online === 'Múltiplos') {
                        multiplos++;
                    }
                    else {
                        naoEncontrado++;
                    }

                    adicionarLinha(tbody, resultado);

                } catch {

                    naoEncontrado++;

                    adicionarLinha(tbody, {
                        login,
                        online: 'Não encontrado',
                        status: 'Não encontrado'
                    });
                }

                resumo.textContent =
                    `Online: ${online} | ` +
                    `Offline: ${offline} | ` +
                    `Múltiplos: ${multiplos} | ` +
                    `Não encontrado: ${naoEncontrado}`;

                if (i < itens.length - 1) {
                    await sleep(INTERVALO_MS);
                }
            }

            status.textContent = 'Consulta concluída';
            if (tbody.rows.length > 0) {

                document.getElementById('pppoe-copiar')
                    .disabled = false;

                document.getElementById('pppoe-exportar')
                    .disabled = false;
            }

        } finally {

            btn.disabled = false;
            btn.textContent = 'Verificar';
        }
    }

    function tratarResultado(login, dados) {

        if (!Array.isArray(dados) || !dados.length) {

            return {
                login,
                online: 'Não encontrado',
                status: 'Não encontrado'
            };
        }

        if (dados.length > 1) {

            return {
                login,
                online: 'Múltiplos',
                status: `${dados.length} registros encontrados`
        };
    }

    const acesso = dados[0]?.acessos?.[0];

    if (!acesso) {

        return {
            login,
            online: 'Não encontrado',
            status: 'Não encontrado'
        };
    }

    return {
        login,
        online:
        acesso.online === 'S'
        ? 'Online'
        : 'Offline',

        status:
        STATUS_ACESSO[acesso.status_acesso]
        || acesso.status_acesso
        || 'Sem status'
    };
}
    function adicionarLinha(tbody, resultado) {

        let classe = 'status-nao-encontrado';

        if (resultado.online === 'Online') {
            classe = 'status-online';
        }
        else if (resultado.online === 'Offline') {
            classe = 'status-offline';
        }
        else if (resultado.online === 'Múltiplos') {
            classe = 'status-multiplos';
        }

        const tr = document.createElement('tr');

        tr.innerHTML = `
            <td>${resultado.login}</td>
            <td class="${classe}">
                ${resultado.online}
            </td>
            <td>${resultado.status}</td>
        `;

        tbody.appendChild(tr);
    }

    function possuiResultados() {

        return document.querySelectorAll(
            '#pppoe-tabela tbody tr'
        ).length > 0;
    }

    function copiarTabela() {
        if (!possuiResultados()) {

            alert(
                'Nenhum resultado disponível para copiar.'
            );

            return;
        }

        const linhas = [
            [
                'Login Informado',
                'Online',
                'Status do Acesso'
            ].join('\t')
        ];

        document
            .querySelectorAll('#pppoe-tabela tbody tr')
            .forEach(tr => {

            linhas.push(
                [...tr.cells]
                .map(td =>
                     td.innerText
                     .replace(/\s+/g, ' ')
                     .trim()
                    )
                .join('\t')
            );
        });

        navigator.clipboard.writeText(
            linhas.join('\r\n')
        );

        alert(
            `${linhas.length - 1} registros copiados para o Excel.`
    );
    }
    function exportarCSV() {
        if (!possuiResultados()) {

            alert(
                'Nenhum resultado disponível para copiar.'
            );

            return;
        }
        const linhas = [];

        linhas.push([
            'Login Informado',
            'Online',
            'Status do Acesso'
        ]);

        document
            .querySelectorAll('#pppoe-tabela tbody tr')
            .forEach(tr => {

            linhas.push(
                [...tr.cells]
                .map(td =>
                     td.innerText
                     .replace(/\s+/g, ' ')
                     .trim()
                    )
            );
        });

        const csv = linhas
        .map(colunas =>
             colunas
             .map(valor =>
                  `"${String(valor).replace(/"/g, '""')}"`
                )
             .join(';')
            )
        .join('\r\n');

        const blob = new Blob(
            ['\ufeff' + csv],
            {
                type: 'text/csv;charset=utf-8;'
            }
        );

        const link =
              document.createElement('a');

        const dataAtual =
              new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, '-');

        link.href =
            URL.createObjectURL(blob);

        link.download =
            `consulta-pppoe-${dataAtual}.csv`;

        document.body.appendChild(link);

        link.click();

        document.body.removeChild(link);

        URL.revokeObjectURL(link.href);
    }

})();
