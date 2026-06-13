// ==UserScript==
// @name         IXC - Consulta em Lote PPPoE/MAC
// @version      2.2
// @description  Consulta em lote de PPPoE ou ONU/MAC com exibição de Status, OLT e CTO
// @author       Lucas Lucian
// @match        https://ixc.rolimnet.com.br/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window) return;

    const VERSAO = GM_info.script.version;
    const LIMITE_ITENS = 250;
    const INTERVALO_MS = 1000;
    let consultaCancelada = false;

    if (!document.getElementById('pppoe-style')) {
        adicionarEstilos();
    }

    GM_registerMenuCommand('Consulta em Lote PPPoE/MAC', () => abrirJanela('UNIFICADA'));

    setTimeout(adicionarMenuIXC, 1000);
    setInterval(adicionarMenuIXC, 3000);

    function abrirJanela(tipo) {
        document.querySelectorAll('#pppoe-consulta-modal').forEach(el => el.remove());

        const modal = document.createElement('div');
        modal.id = 'pppoe-consulta-modal';
        const titulo = 'Consulta em Lote PPPoE/MAC';

        modal.innerHTML = `
            <div id="pppoe-box">
                <div id="pppoe-header">
                    <span>${titulo} - v${VERSAO}</span>
                    <button id="pppoe-fechar">✖</button>
                </div>
                <div style="margin-bottom:8px">
                    <label><input type="radio" name="tipoBusca" value="PPPOE" checked> PPPoE</label>
                    <label style="margin-left:15px"><input type="radio" name="tipoBusca" value="MAC"> ONU/MAC</label>
                </div>
                <textarea id="pppoe-lista" placeholder="Informe um item por linha (máximo ${LIMITE_ITENS})"></textarea>
                <div id="pppoe-info">
                    <span id="pppoe-contador">0 / ${LIMITE_ITENS} itens</span>
                    <span id="pppoe-tempo">Tempo estimado: 0s</span>
                </div>
                <div id="pppoe-toolbar">
                    <button id="pppoe-verificar">Verificar</button>
                    <button id="pppoe-copiar" disabled>Copiar para Excel</button>
                    <button id="pppoe-exportar" disabled>Exportar CSV</button>
                    <span id="pppoe-status">Aguardando...</span>
                </div>
                <div id="pppoe-resumo">
                    Online: 0 | Offline: 0 | Múltiplos: 0 | Não encontrado: 0
                </div>
                <div id="pppoe-tabela-wrapper">
                    <table id="pppoe-tabela">
                        <thead>
                            <tr>
                                <th>MAC</th><th>PPPoE</th><th>Online</th><th>Status Contrato</th><th>OLT</th><th>CTO</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.classList.add('pppoe-modal-aberto');

        const fecharModal = () => {
            consultaCancelada = true;
            document.body.classList.remove('pppoe-modal-aberto');
            document.removeEventListener('keydown', escHandler);
            modal.remove();
        };

        const escHandler = (e) => {
            if (e.key === 'Escape') fecharModal();
        };

        document.addEventListener('keydown', escHandler);
        document.getElementById('pppoe-fechar').addEventListener('click', fecharModal);

        document.getElementById('pppoe-verificar').addEventListener('click', () => {
            const modo = document.querySelector('input[name="tipoBusca"]:checked').value;
            iniciarConsulta(modo);
        });

        document.getElementById('pppoe-copiar').addEventListener('click', copiarTabela);
        document.getElementById('pppoe-exportar').addEventListener('click', exportarCSV);
        document.getElementById('pppoe-lista').addEventListener('input', atualizarContador);

        atualizarContador();
    }

    function adicionarMenuIXC() {
        if (document.getElementById('menu_item_pppoe_lote')) return;

        const plataformaVoip = [...document.querySelectorAll('.submenu_title a')]
            .find(el => el.textContent.trim() === 'Plataforma Voip');

        if (!plataformaVoip) return;

        const menuPai = plataformaVoip.closest('.menu_p');
        const submenuVoip = menuPai?.nextElementSibling;

        if (!submenuVoip) return;

        const wrapper = document.createElement('div');
        wrapper.id = 'menu_item_pppoe_lote';

        wrapper.innerHTML = `
            <div class="menu_p menu_fechado" style="margin-top: 2px;">
                <div class="submenu_title">
                    <a id="btn_pppoe_unificado" style="cursor:pointer; display:block;">
                        Consulta em Lote PPPoE/MAC
                    </a>
                </div>
            </div>
        `;

        submenuVoip.after(wrapper);
        wrapper.querySelector('#btn_pppoe_unificado').addEventListener('click', () => abrirJanela('UNIFICADA'));
    }

    function adicionarEstilos() {
        const style = document.createElement('style');
        style.id = 'pppoe-style';
        style.textContent = `
            body.pppoe-modal-aberto{ overflow:hidden; }
            #pppoe-consulta-modal{ position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,.45); z-index:2147483647; display:flex; justify-content:center; align-items:center; pointer-events:auto; }
            #pppoe-box{ width:min(1400px,95vw); height:min(850px,90vh); background:#fff; color:#000; border-radius:8px; box-shadow:0 0 30px rgba(0,0,0,.35); padding:15px; box-sizing:border-box; display:flex; flex-direction:column; }
            #pppoe-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; font-size:18px; font-weight:bold; }
            #pppoe-fechar{ cursor:pointer; }
            #pppoe-lista{ width:100%; height:220px; resize:none; padding:8px; box-sizing:border-box; font-family:Consolas, monospace; }
            #pppoe-info{ margin-top:5px; margin-bottom:10px; font-size:12px; color:#666; display:flex; justify-content:space-between; }
            #pppoe-toolbar{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }
            #pppoe-status{ margin-left:auto; font-weight:bold; }
            #pppoe-resumo{ margin-bottom:10px; font-weight:bold; }
            #pppoe-tabela-wrapper{ flex:1; overflow:auto; border:1px solid #ddd; }
            #pppoe-tabela{ width:100%; border-collapse:collapse; }
            #pppoe-tabela th, #pppoe-tabela td{ border:1px solid #ddd; padding:8px; color:#000; white-space:normal; word-break:break-word; }
            #pppoe-tabela th{ background:#e8e8e8; position:sticky; top:0; z-index:1; }
            #pppoe-tabela th:nth-child(1), #pppoe-tabela td:nth-child(1){ width:15%; }
            #pppoe-tabela th:nth-child(2), #pppoe-tabela td:nth-child(2){ width:25%; }
            #pppoe-tabela th:nth-child(3), #pppoe-tabela td:nth-child(3){ width:12%; text-align:center; }
            #pppoe-tabela th:nth-child(4), #pppoe-tabela td:nth-child(4){ width:18%; }
            #pppoe-tabela th:nth-child(5), #pppoe-tabela td:nth-child(5){ width:15%; }
            #pppoe-tabela th:nth-child(6), #pppoe-tabela td:nth-child(6){ width:15%; }
            #pppoe-tabela, #pppoe-tabela *{ user-select:text !important; -webkit-user-select:text !important; -moz-user-select:text !important; -ms-user-select:text !important; }
            #pppoe-tabela td{ cursor:text; }
            #pppoe-tabela tbody tr:hover{ background:#f5f5f5; }
            .status-online{ background:#dff0d8 !important; color:#008000 !important; font-weight:bold; }
            .status-offline{ background:#f2dede !important; color:#cc0000 !important; font-weight:bold; }
            .status-nao-encontrado{ background:#fcf8e3 !important; color:#a67c00 !important; font-weight:bold; }
            .status-multiplos{ background:#d9edf7 !important; color:#31708f !important; font-weight:bold; }
        `;
        document.head.appendChild(style);
    }

    function atualizarContador() {
        const textarea = document.getElementById('pppoe-lista');
        const contador = document.getElementById('pppoe-contador');
        const tempo = document.getElementById('pppoe-tempo');

        const total = textarea.value.split('\n').map(v => v.trim()).filter(Boolean).length;
        contador.textContent = `${total} / ${LIMITE_ITENS} itens`;

        const segundos = total * (INTERVALO_MS / 1000);
        if (segundos < 60) {
            tempo.textContent = `Tempo estimado: ${segundos}s`;
        } else {
            const minutos = Math.floor(segundos / 60);
            tempo.textContent = `Tempo estimado: ${minutos}m ${segundos % 60}s`;
        }
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function iniciarConsulta(tipo) {
        consultaCancelada = false;
        const btn = document.getElementById('pppoe-verificar');
        const textarea = document.getElementById('pppoe-lista');
        const tbody = document.querySelector('#pppoe-tabela tbody');
        const status = document.getElementById('pppoe-status');
        const resumo = document.getElementById('pppoe-resumo');
        const itens = textarea.value.split('\n').map(v => v.trim()).filter(Boolean);

        if (!itens.length) return alert('Informe pelo menos um item.');
        if (itens.length > LIMITE_ITENS) return alert(`Limite máximo de ${LIMITE_ITENS} itens.`);

        btn.disabled = true;
        btn.textContent = 'Consultando...';
        tbody.innerHTML = '';
        document.getElementById('pppoe-copiar').disabled = true;
        document.getElementById('pppoe-exportar').disabled = true;

        let online = 0, offline = 0, multiplos = 0, naoEncontrado = 0;

        try {
            for (let i = 0; i < itens.length; i++) {
                if (consultaCancelada) {
                    status.textContent = 'Consulta cancelada';
                    break;
                }

                const login = itens[i];
                status.textContent = `Consultando ${i + 1}/${itens.length}`;

                try {
                    const bodyParams = new URLSearchParams();
                    bodyParams.append('page', '1');
                    bodyParams.append('rp', '21');
                    bodyParams.append('sortname', 'radusuarios.id');
                    bodyParams.append('sortorder', 'desc');
                    bodyParams.append('grid_param2', 'false');

                    if (tipo === 'PPPOE') {
                        bodyParams.append('query', '');
                        bodyParams.append('qtype', 'radusuarios.login');
                        bodyParams.append('oper', 'L');
                        const gridParamObj = { "0": { "TB": "radusuarios.login", "display": "Login", "OP": "=", "P": login, "C": "AND", "G": "_radusuarios.login" } };
                        bodyParams.append('grid_param', JSON.stringify(gridParamObj));
                        bodyParams.append('display', 'Login');
                    } else if (tipo === 'MAC') {
                        const gridParamObj = { "0": { "TB": "radusuarios.onu_mac", "display": "ONU+MAC", "OP": "=", "P": login, "C": "AND", "G": "_radusuarios.onu_mac" } };
                        bodyParams.append('grid_param', JSON.stringify(gridParamObj));
                        bodyParams.append('display', 'ONU+MAC');
                    }

                    const response = await fetch(`/aplicativo/radusuarios/action/action.php?action=grid&relation=false&advanced_search=false`, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'X-Requested-With': 'XMLHttpRequest',
                            'Accept': 'text/html, */*; q=0.01'
                        },
                        body: bodyParams.toString()
                    });

                    const dados = await response.json();
                    if (consultaCancelada) return;

                    const resultado = tratarResultado(login, dados);

                    // CONTADOR CORRIGIDO:
                    if (resultado.length > 1 && resultado[0].online !== 'Não encontrado') {
                        multiplos++; // Agora soma APENAS se o array retornar 2 ou mais itens
                    } else {
                        const r = resultado[0];
                        if (r.online === 'Online') {
                            online++;
                        } else if (r.online === 'Offline' || r.online === 'Bloqueado' || r.online === 'Sem Sessão') {
                            offline++; // Sem Sessão agora conta como Offline
                        } else {
                            naoEncontrado++;
                        }
                    }

                    // Renderiza a tabela
                    for (const r of resultado) {
                        adicionarLinha(tbody, r);
                    }

                } catch (err) {
                    console.error("Erro na consulta do login", login, err);
                    naoEncontrado++;
                    adicionarLinha(tbody, { mac: '-', pppoe: login, online: 'Não encontrado', status: 'Erro na requisição', olt: '-', cto: '-' });
                }

                resumo.textContent = `Online: ${online} | Offline: ${offline} | Múltiplos: ${multiplos} | Não encontrado: ${naoEncontrado}`;

                if (i < itens.length - 1) {
                    await sleep(INTERVALO_MS);
                    if (consultaCancelada) return;
                }
            }

            if (!consultaCancelada && status) status.textContent = 'Consulta concluída';

            if (tbody.rows.length > 0) {
                document.getElementById('pppoe-copiar').disabled = false;
                document.getElementById('pppoe-exportar').disabled = false;
            }
        } finally {
            if (document.body.contains(btn)) {
                btn.disabled = false;
                btn.textContent = 'Verificar';
            }
        }
    }

    function tratarResultado(login, dados) {
        if (!dados || !dados.rows || !dados.rows.length) {
            return [{ mac: '-', pppoe: login, online: 'Não encontrado', status: 'Não encontrado', olt: '-', cto: '-' }];
        }

        return dados.rows.map(row => {
            const c = row.cell;
            let situacao = 'Offline';

            if ((c[7] || '').includes('Bloqueio')) situacao = 'Bloqueado';
            else if (String(c[1] || '').trim() === 'Sim' && String(c[2] || '').trim() === 'Sim') situacao = 'Online';
            else if (String(c[1] || '').trim() === 'Sim') situacao = 'Offline';

            return {
                mac: c[45] || '-',
                pppoe: c[10] || login,
                online: situacao,
                status: c[7] || c[6] || 'Sem status',
                olt: c[34] || '-',
                cto: c[35] || '-'
            };
        });
    }

    function adicionarLinha(tbody, resultado) {
        const classes = {
            'Online': 'status-online',
            'Offline': 'status-offline',
            'Bloqueado': 'status-offline',
            'Sem Sessão': 'status-offline', // Sem Sessão agora recebe a cor vermelha de offline também
            'Múltiplos': 'status-multiplos'
        };

        const classe = classes[resultado.online] || 'status-nao-encontrado';
        const tr = document.createElement('tr');

        tr.innerHTML = `
            <td>${resultado.mac || ''}</td>
            <td>${resultado.pppoe || ''}</td>
            <td class="${classe}">${resultado.online || ''}</td>
            <td>${resultado.status || ''}</td>
            <td>${resultado.olt || '-'}</td>
            <td>${resultado.cto || '-'}</td>
        `;

        tbody.appendChild(tr);
    }

    function possuiResultados() { return document.querySelectorAll('#pppoe-tabela tbody tr').length > 0; }

    function copiarTabela() {
        if (!possuiResultados()) return;
        const linhas = [['MAC','PPPoE','Online','Status Contrato','OLT','CTO'].join('\t')];
        document.querySelectorAll('#pppoe-tabela tbody tr').forEach(tr => {
            linhas.push([...tr.cells].map(td => td.innerText.replace(/\s+/g, ' ').trim()).join('\t'));
        });
        navigator.clipboard.writeText(linhas.join('\r\n'));
        alert(`${linhas.length - 1} registros copiados!`);
    }

    function exportarCSV() {
        if (!possuiResultados()) return;
        const linhas = [['MAC','PPPoE','Online','Status Contrato','OLT','CTO']];
        document.querySelectorAll('#pppoe-tabela tbody tr').forEach(tr => {
            linhas.push([...tr.cells].map(td => td.innerText.replace(/\s+/g, ' ').trim()));
        });
        const csv = linhas.map(colunas => colunas.map(valor => `"${String(valor).replace(/"/g, '""')}"`).join(';')).join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `consulta-pppoe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
        document.body.appendChild(link);
        link.click();
        URL.revokeObjectURL(link.href);
        document.body.removeChild(link);
    }
})();
