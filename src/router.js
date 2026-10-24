module.exports = (PUBLIC_DIR, routes, serveStatic) => {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;

    try {

          // ===== АВТОРИЗАЦИЯ =====
                if (p === '/api/auth/login' && method === 'POST') 
                        return await routes.auth.POST_LOGIN(req, res);
                if (p === '/api/auth/users' && method === 'POST')
                return await routes.auth.POST_USER(req, res);
                if (p === '/api/auth/logout' && method === 'POST') 
                        return await routes.auth.POST_LOGOUT(req, res);
                if (p === '/api/auth/me' && method === 'GET') 
                        return await routes.auth.GET_ME(req, res, url);
                if (p === '/api/auth/users' && method === 'GET') 
                        return await routes.auth.GET_USERS(req, res, url);
                if (p === '/api/auth/roles' && method === 'GET') 
                        return await routes.auth.GET_ROLES(req, res, url);
                if (p.match(/^\/api\/auth\/users\/[^/]+$/) && method === 'PUT') 
                        return await routes.auth.PUT_USER(req, res, url);
                if (p.match(/^\/api\/auth\/users\/[^/]+\/password$/) && method === 'PUT') 
                        return await routes.auth.PUT_PASSWORD(req, res, url);
                if (p.match(/^\/api\/auth\/users\/[^/]+$/) && method === 'DELETE') 
                        return await routes.auth.DELETE_USER(req, res, url);
                if (p === '/api/auth/logs' && method === 'GET') 
                        return await routes.auth.GET_LOGS(req, res, url);

      // ===== API маршруты =====
      if (p === '/api/firmy' || p.match(/^\/api\/firmy\//)) {
        if (method === 'GET' && p === '/api/firmy') return await routes.firma.GET(req, res, url);
        if (method === 'POST' && p === '/api/firmy') return await routes.firma.POST(req, res);
        if (method === 'PUT' && p.match(/^\/api\/firmy\/[^/]+$/)) return await routes.firma.PUT(req, res, url);
        if (method === 'DELETE' && p.match(/^\/api\/firmy\/[^/]+$/)) return await routes.firma.DELETE(req, res, url);
      }

      if (p === '/api/adres' || p.match(/^\/api\/adres\//)) {
        if (method === 'GET' && p === '/api/adres') return await routes.adres.GET(req, res, url);
        if (method === 'POST' && p === '/api/adres') return await routes.adres.POST(req, res);
        if (method === 'PUT' && p.match(/^\/api\/adres\/[^/]+$/)) return await routes.adres.PUT(req, res, url);
        if (method === 'DELETE' && p.match(/^\/api\/adres\/[^/]+$/)) return await routes.adres.DELETE(req, res, url);
      }

      if (p === '/api/kont' || p.match(/^\/api\/kont\//)) {
        if (method === 'GET' && p === '/api/kont') return await routes.kont.GET(req, res, url);
        if (method === 'POST' && p === '/api/kont') return await routes.kont.POST(req, res);
        if (method === 'PUT' && p.match(/^\/api\/kont\/[^/]+$/)) return await routes.kont.PUT(req, res, url);
        if (method === 'DELETE' && p.match(/^\/api\/kont\/[^/]+$/)) return await routes.kont.DELETE(req, res, url);
      }

      if (p === '/api/dogovor' || p.match(/^\/api\/dogovor\//)) {
        if (method === 'GET' && p === '/api/dogovor') return await routes.dogovor.GET(req, res, url);
        if (method === 'POST' && p === '/api/dogovor') return await routes.dogovor.POST(req, res);
        if (method === 'PUT' && p.match(/^\/api\/dogovor\/[^/]+$/)) return await routes.dogovor.PUT(req, res, url);
        if (method === 'DELETE' && p.match(/^\/api\/dogovor\/[^/]+$/)) return await routes.dogovor.DELETE(req, res, url);
      }

          // ===== ВИДЫ РАБОТ ПО ДОГОВОРАМ =====
        if (p === '/api/sprav-vidy-rabot' && method === 'GET')
        return await routes.vidyRabot.GET_SPRAV(req, res, url);
        if (p === '/api/vidy-rabot' || p.match(/^\/api\/vidy-rabot\//)) {
        if (method === 'GET' && p === '/api/vidy-rabot') return await routes.vidyRabot.GET(req, res, url);
        if (method === 'POST' && p === '/api/vidy-rabot') return await routes.vidyRabot.POST(req, res);
        if (method === 'POST' && p === '/api/vidy-rabot/copy') return await routes.vidyRabot.POST_COPY(req, res);
        if (method === 'PUT' && p.match(/^\/api\/vidy-rabot\/[^/]+$/)) return await routes.vidyRabot.PUT(req, res, url);
        if (method === 'DELETE' && p.match(/^\/api\/vidy-rabot\/[^/]+$/)) return await routes.vidyRabot.DELETE(req, res, url);
        }
              // ===== ПРОТОКОЛ СОВЕЩАНИЙ =====
    if (p === '/api/meeting' || p.match(/^\/api\/meeting\//)) {
        if (method === 'GET' && p === '/api/meeting/firms')     return await routes.meeting.GET_FIRMS(req, res);
        if (method === 'GET' && p === '/api/meeting/positions') return await routes.meeting.GET_POSITIONS(req, res, url);
        if (method === 'GET' && p === '/api/meeting/batch')     return await routes.meeting.GET_BATCH(req, res, url);
        if (method === 'PUT' && p === '/api/meeting/fakt')      return await routes.meeting.PUT_FAKT(req, res);
        if (method === 'POST' && p === '/api/meeting/op')       return await routes.meeting.POST_OP(req, res);
    }

      if (p === '/api/uslov' || p.match(/^\/api\/uslov\//)) {
        if (method === 'GET' && p === '/api/uslov') return await routes.uslov.GET(req, res, url);
        if (method === 'POST' && p === '/api/uslov') return await routes.uslov.POST(req, res);
        if (method === 'PUT' && p.match(/^\/api\/uslov\/[^/]+$/)) return await routes.uslov.PUT(req, res, url);
        if (method === 'DELETE' && p.match(/^\/api\/uslov\/[^/]+$/)) return await routes.uslov.DELETE(req, res, url);
      }
                if (p === '/api/osnastka' || p.match(/^\/api\/osnastka\//)) {
                        if (method === 'GET' && p === '/api/osnastka') return await routes.osnastka.GET(req, res, url);
                        if (method === 'POST' && p === '/api/osnastka') return await routes.osnastka.POST(req, res);
                        if (method === 'PUT' && p.match(/^\/api\/osnastka\/[^/]+$/)) return await routes.osnastka.PUT(req, res, url);
                        if (method === 'DELETE' && p.match(/^\/api\/osnastka\/[^/]+$/)) return await routes.osnastka.DELETE(req, res, url);
                }       
                
                 // ===== ПЛАН =====
                if (p === '/api/plan' || /^\/api\/plan\//.test(p)) {
                        if (p === '/api/plan/detail' && method === 'GET') return await routes.plan.GET_DETAIL(req, res, url);
                        if (p === '/api/plan' && method === 'GET') return await routes.plan.GET(req, res, url); 
                        if (p === '/api/plan' && method === 'POST')  return await routes.plan.POST(req, res);
                        if (/^\/api\/plan\/[^/]+$/.test(p)) {
                                if (method === 'PUT') return await routes.plan.PUT(req, res, url); 
                                if (method === 'DELETE') return await routes.plan.DELETE(req, res, url); 
                        }
                }
                
                // ===== ЦЕХА =====
                if (p === '/api/cex' || p.match(/^\/api\/cex\//)) {
                        if (method === 'GET' && p === '/api/cex') return await routes.cex.GET(req, res, url);
                        if (method === 'POST' && p === '/api/cex') return await routes.cex.POST(req, res);
                        if (method === 'PUT' && p.match(/^\/api\/cex\/[^/]+$/)) return await routes.cex.PUT(req, res, url);
                        if (method === 'DELETE' && p.match(/^\/api\/cex\/[^/]+$/)) return await routes.cex.DELETE(req, res, url);
                }
                // ===== ГРАФИК =====
                if (p === '/api/grafik/plans' && method === 'GET') return await routes.grafik.GET_PLANS(req, res, url);
                if (p === '/api/grafik' && method === 'GET') return await routes.grafik.GET(req, res, url);
                if (p === '/api/grafik/bulk' && method === 'POST') return await routes.grafik.POST_BULK(req, res);
                if (p === '/api/grafik/save' && method === 'POST') return await routes.grafik.POST_SAVE(req, res);
                if (p === '/api/grafik' && method === 'DELETE') return await routes.grafik.DELETE(req, res, url);
                
                // ===== ПЕРЕВОЗЧИКИ =====
                if (p === '/api/perevozchik' || p.match(/^\/api\/perevozchik\//)) {
                  if (method === 'GET' && p === '/api/perevozchik') return await routes.perevozchik.GET(req, res, url);
                  if (method === 'POST' && p === '/api/perevozchik') return await routes.perevozchik.POST(req, res);
                  if (method === 'PUT' && p.match(/^\/api\/perevozchik\/[^/]+$/)) return await routes.perevozchik.PUT(req, res, url);
                  if (method === 'DELETE' && p.match(/^\/api\/perevozchik\/[^/]+$/)) return await routes.perevozchik.DELETE(req, res, url);
                }
                
                // ===== ТЕХНОЛОГИ =====
                if (p === '/api/tech' || p.match(/^\/api\/tech\//)) {
                        if (method === 'GET' && p === '/api/tech') return await routes.tech.GET(req, res, url);
                        if (method === 'POST' && p === '/api/tech') return await routes.tech.POST(req, res);
                        if (method === 'PUT' && p.match(/^\/api\/tech\/[^/]+$/)) return await routes.tech.PUT(req, res, url);
                        if (method === 'DELETE' && p.match(/^\/api\/tech\/[^/]+$/)) return await routes.tech.DELETE(req, res, url);
                }
                
                // ===== ТИПЫ ПЕРЕВОЗОК =====
                if (p === '/api/transport_types' || p.match(/^\/api\/transport_types\//)) {
                  if (method === 'GET' && p === '/api/transport_types') return await routes.transportTypes.GET(req, res, url);
                  if (method === 'POST' && p === '/api/transport_types') return await routes.transportTypes.POST(req, res);
                  if (method === 'PUT' && p.match(/^\/api\/transport_types\/[^/]+$/)) return await routes.transportTypes.PUT(req, res, url);
                  if (method === 'DELETE' && p.match(/^\/api\/transport_types\/[^/]+$/)) return await routes.transportTypes.DELETE(req, res, url);
                }
                
                // ===== МАРШРУТЫ =====
                if (p === '/api/routes' && method === 'GET') return await routes.marshrut.GET_ROUTE(req, res, url);
                if (p === '/api/steps' && method === 'POST') return await routes.marshrut.POST_SHAG(req, res);
                if (p.match(/^\/api\/steps\/[^/]+$/) && method === 'PUT') return await routes.marshrut.PUT_SHAG(req, res, url);
                if (p.match(/^\/api\/steps\/[^/]+$/) && method === 'DELETE') return await routes.marshrut.DELETE_SHAG(req, res, url);
                if (p === '/api/operations' && method === 'POST') return await routes.marshrut.POST_OPER(req, res);
                if (p.match(/^\/api\/operations\/[^/]+$/) && method === 'PUT') return await routes.marshrut.PUT_OPER(req, res, url);
                if (p.match(/^\/api\/operations\/[^/]+$/) && method === 'DELETE') return await routes.marshrut.DELETE_OPER(req, res, url);
                if (p === '/api/steps/swap' && method === 'POST') return await routes.marshrut.POST_SWAP(req, res);
                if (p === '/api/routes/copy' && method === 'POST') return await routes.marshrut.POST_COPY(req, res);
                if (p === '/api/routes/missing' && method === 'GET') return await routes.marshrut.GET_MISSING(req, res);
                if (p === '/api/routes/bulk-standard' && method === 'POST') return await routes.marshrut.POST_BULK_STANDARD(req, res);
                
                // ===== ПЛАН ПЕРЕВОЗОК =====
                if (p === '/api/plan_perevozok' && method === 'GET') return await routes.planPerevozok.GET(req, res, url);
                if (p === '/api/plan_perevozok/available' && method === 'GET') return await routes.planPerevozok.GET_AVAILABLE(req, res, url);
                if (p === '/api/plan_perevozok' && method === 'POST') return await routes.planPerevozok.POST(req, res);
                if (p === '/api/plan_perevozok/bulk' && method === 'POST') return await routes.planPerevozok.POST_BULK(req, res);
                if (p.match(/^\/api\/plan_perevozok\/[^/]+$/) && method === 'PUT') return await routes.planPerevozok.PUT(req, res, url);
                if (p.match(/^\/api\/plan_perevozok\/[^/]+$/) && method === 'DELETE') return await routes.planPerevozok.DELETE(req, res, url);  
                        

                // ===== ЗАПРОСЫ КП - СИНТЕТИЧЕСКИЕ ТАБЛИЦЫ =====
                if (p === '/api/zapros-kp' && method === 'GET') return await routes.zaprosKp.GET(req, res, url);
                // ✅ T89: проверка доступности файлов по публичной ссылке (поле «Ссылка», шаг 2)
                if (p === '/api/zapros-kp/check-url' && method === 'POST') return await routes.zaprosKp.POST_CHECK_URL(req, res);
                if (p === '/api/zapros-kp/firmy-dogovory' && method === 'GET') return await routes.zaprosKp.GET_DOGOVORY_MAP(req, res, url);// ✅ НОВЫЙ: карта «фирма → договор» для колонки в списках фирм
                if (p === '/api/zapros-kp/with-kp' && method === 'POST') return await routes.zaprosKp.POST_WITH_KP(req, res);
                // ✅ T78: требование запроса «все позиции изготавливаются комплектом»
                // (чекбокс «не допускается разбивать партию» на странице «Внесение КП»)
                if (p === '/api/zapros-kp/komplekt' && method === 'POST') return await routes.zaprosKp.POST_KOMPLEKT(req, res);
                if (p.match(/^\/api\/zapros-kp\/[^/]+\/with-kp$/) && method === 'PUT') return await routes.zaprosKp.PUT_WITH_KP(req, res, url);
                if (p.match(/^\/api\/zapros-kp\/[^/]+\/with-kp$/) && method === 'DELETE') return await routes.zaprosKp.DELETE_WITH_KP(req, res, url);
                if (p.match(/^\/api\/zapros-kp\/[^/]+\/position\/[^/]+$/) && method === 'DELETE') return await routes.zaprosKp.DELETE_POSITION(req, res, url);
                if (p === '/api/kom-predl' && method === 'GET') return await routes.zaprosKp.GET_KOM_PREDL(req, res, url);
                if (p === '/api/kom-predl/all' && method === 'GET') return await routes.zaprosKp.GET_ALL_KOM_PREDL(req, res);
                if (p.match(/^\/api\/kom-predl\/[^/]+\/email$/) && method === 'PUT') return await routes.zaprosKp.PUT_EMAIL_DATA(req, res, url);
                if (p === '/api/plan/available' && method === 'GET') return await routes.zaprosKp.GET_AVAILABLE_DETALIPLAN(req, res, url);// ✅ НОВЫЙ endpoint для доступных деталей
                if (p === '/api/zapros-kp/status' && method === 'GET')     return await routes.zaprosKp.GET_STATUS(req, res, url);
                if (p === '/api/zapros-kp/zaprosy' && method === 'GET')     return await routes.zaprosKp.GET_ZAPROSY(req, res, url);
                // ✅ T51: СЗ «Согласование заказа по запросу ТКП» (шаг 1) и поля согласования (шаг 2)
                if (p === '/api/zapros-kp/sz-soglas-preview' && method === 'POST') return await routes.zaprosKp.POST_SZ_SOGLAS_PREVIEW(req, res);
                if (p === '/api/zapros-kp/create-sz-soglas' && method === 'POST') return await routes.zaprosKp.POST_CREATE_SZ_SOGLAS(req, res);
                // ✅ T51-c: удаление СЗ согласования (красный крестик шага 1 «Внесение КП»)
                if (p === '/api/zapros-kp/delete-sz-soglas' && method === 'POST') return await routes.zaprosKp.POST_DELETE_SZ_SOGLAS(req, res);
                if (p.match(/^\/api\/zapros-kp\/[^/]+\/soglas$/) && method === 'PUT') return await routes.zaprosKp.PUT_SGLAS(req, res, url);

                // ✅ T52: НАСТРОЙКИ ЭДО (config/edo.json) — страница «Настройки ЭДО»:
                // чтение, сохранение и проверка соединения с порталом ВАЗ
                if (p === '/api/edo-settings' && method === 'GET') return await routes.edoSettings.GET_SETTINGS(req, res);
                if (p === '/api/edo-settings' && method === 'POST') return await routes.edoSettings.POST_SETTINGS(req, res);
                if (p === '/api/edo-settings/test' && method === 'POST') return await routes.edoSettings.TEST_CONNECTION(req, res);

                // ✅ ОТЧЁТЫ: «Плоская таблица» (кнопка в блоке «Отчеты» главной страницы)
                if (p === '/api/reports/flat-table-filters' && method === 'GET') return await routes.reports.GET_FLAT_TABLE_FILTERS(req, res);
                if (p === '/api/reports/flat-table' && method === 'GET') return await routes.reports.GET_FLAT_TABLE(req, res, url);

                // ✅ T102: ОПЛАТА РАБОТ (страница «Оплата работ»)
                if (p === '/api/oplata/operatsii' && method === 'GET') return await routes.oplata.GET_OPERATSII(req, res, url);
                if (p === '/api/oplata/pozicii' && method === 'GET') return await routes.oplata.GET_POZICII(req, res, url);
                if (p === '/api/oplata/zapisi' && method === 'GET') return await routes.oplata.GET_ZAPISI(req, res, url);
                if (p === '/api/oplata/raspredelenie' && method === 'GET') return await routes.oplata.GET_RASPRED(req, res, url); // ✅ T104
                if (p === '/api/oplata/zapisi' && method === 'POST') return await routes.oplata.POST_ZAPIS(req, res);
                if (p === '/api/oplata/privyazat' && method === 'POST') return await routes.oplata.POST_PRIVYAZAT(req, res);
                if (p === '/api/oplata/otvyazat' && method === 'POST') return await routes.oplata.POST_OTVYAZAT(req, res);
                if (p.match(/^\/api\/oplata\/zapisi\/[^/]+$/) && method === 'PUT') return await routes.oplata.PUT_ZAPIS(req, res, url);
                if (p.match(/^\/api\/oplata\/zapisi\/[^/]+$/) && method === 'DELETE') return await routes.oplata.DELETE_ZAPIS(req, res, url);
                // ✅ T106: шаги работы с платежкой (файлы шагов 1/4, отправка на почту)
                if (p.match(/^\/api\/oplata\/zapisi\/[^/]+\/step$/) && method === 'PUT') return await routes.oplata.PUT_STEP(req, res, url);
                if (p === '/api/oplata/upload-file' && method === 'POST') return await routes.oplata.POST_UPLOAD_FILE(req, res, url);
                if (p === '/api/oplata/send-email' && method === 'POST') return await routes.oplata.POST_SEND_EMAIL(req, res);

                
                // ===== КОММЕРЧЕСКИЕ ПРЕДЛОЖЕНИЯ =====
                if (p === '/api/kom-predl' && method === 'GET') return await routes.zaprosKp.GET_KOM_PREDL(req, res, url);
                if (p === '/api/kom-predl/all' && method === 'GET') return await routes.zaprosKp.GET_ALL_KOM_PREDL(req, res);
                if (p === '/api/kom-predl/summary' && method === 'GET') return await routes.zaprosKp.GET_KP_SUMMARY(req, res, url);
                if (p.match(/^\/api\/kom-predl\/[^/]+\/email$/) && method === 'PUT') return await routes.zaprosKp.PUT_EMAIL_DATA(req, res, url);
                if (p.match(/^\/api\/kom-predl\/[^/]+$/) && method === 'PUT') return await routes.zaprosKp.PUT_KOM_PREDL(req, res, url);
                if (p === '/api/kom-predl/best' && method === 'POST') return await routes.zaprosKp.POST_BEST_KP(req, res);
                if (p === '/api/kom-predl/manual-best' && method === 'POST') return await routes.zaprosKp.POST_MANUAL_BEST_KP(req, res);
                // ✅ T19-ISKLYUCHEN: установить/снять флаг «исключён из расчётов» у КП
                if (p === '/api/kom-predl/set-isklyuchen' && method === 'POST') return await routes.zaprosKp.POST_SET_ISKLYUCHEN(req, res);
                if (p === '/api/kom-predl/import-excel' && method === 'POST') return await routes.zaprosKp.POST_IMPORT_EXCEL(req, res);
                if (p === '/api/kom-predl/export-summary' && method === 'POST') return await routes.zaprosKp.POST_EXPORT_SUMMARY(req, res);
                // ✅ T48: основание от фирмы по запросу КП (PDF, таблица ТКПоснование;
                //   файлы хранятся в public/запросы/<год>/<номер запроса>/)
                if (p === '/api/kom-predl/osnovanie' && method === 'GET') return await routes.zaprosKp.GET_OSNOVANIE(req, res, url);
                if (p === '/api/kom-predl/osnovanie/upload' && method === 'POST') return await routes.zaprosKp.POST_OSNOVANIE_UPLOAD(req, res, url);
                // ===== ТРАНСПОРТНЫЕ ОПЕРАЦИИ =====
                if (p === '/api/transport-oper' || p.match(/^\/api\/transport-oper\//)) {
                        if (method === 'GET' && p === '/api/transport-oper') return await routes.transportOper.GET(req, res, url);
                        if (method === 'GET' && p === '/api/transport-oper/poz') return await routes.transportOper.GET_POZ(req, res, url);
                        if (method === 'GET' && p === '/api/transport-oper/available') return await routes.transportOper.GET_AVAILABLE(req, res, url);
                        if (method === 'GET' && p === '/api/transport-oper/zatrat-lists') return await routes.transportOper.GET_ZATRAT_LISTS(req, res, url);
                    // ✅ ТИПЫ ГРУЗА: ранее введённые наименования + расчёт тарных мест + параметры заготовки
                    if (method === 'GET' && p === '/api/transport-oper/gruz-names') return await routes.transportOper.GET_GRUZ_NAMES(req, res);
                    if (method === 'GET' && p === '/api/transport-oper/select-lists') return await routes.transportOper.GET_SELECT_LISTS(req, res);
                    if (method === 'POST' && p === '/api/transport-oper/calc-tara') return await routes.transportOper.POST_CALC_TARA(req, res);
                    if (method === 'POST' && p === '/api/transport-oper/tarn-apply') return await routes.transportOper.POST_TARN_APPLY(req, res);
                    if (method === 'POST' && p === '/api/transport-oper/poz-params') return await routes.transportOper.POST_POZ_PARAMS(req, res);
                        if (method === 'POST' && p === '/api/transport-oper') return await routes.transportOper.POST(req, res);
                        if (method === 'POST' && p === '/api/transport-oper/auto-fill') return await routes.transportOper.POST_AUTO_FILL(req, res);
                        // ✅ T37: Создать СЗ в системе + данные СЗ (файл заявки)
                        if (method === 'POST' && p === '/api/transport-oper/create-sz') return await routes.transportOper.POST_CREATE_SZ(req, res);
                        // ✅ T59: второй шаг «Создать СЗ в системе» — после предпросмотра файла:
                        // подтверждение (шаги 7-8 VBA) или отмена (удаление локального файла)
                        if (method === 'POST' && p === '/api/transport-oper/create-sz-confirm') return await routes.transportOper.POST_SZ_CONFIRM(req, res);
                        // ✅ T42: СЗ в СБ об отгрузке (шаблон 65133697, подписант со страницы)
                        if (method === 'POST' && p === '/api/transport-oper/create-sz-sb') return await routes.transportOper.POST_CREATE_SZ_SB(req, res);
                        // ✅ T43: предпросмотр письма СЗ в СБ (модальное окно редактирования)
                        if (method === 'POST' && p === '/api/transport-oper/sz-sb-preview') return await routes.transportOper.POST_SZ_SB_PREVIEW(req, res);
                        if (method === 'GET' && p === '/api/transport-oper/sz-info') return await routes.transportOper.GET_SZ_INFO(req, res, url);
                        // ✅ T38: создать накладные М-15 в системе ВАЗ (SIPORA)
                        if (method === 'POST' && p === '/api/transport-oper/create-m15') return await routes.transportOper.POST_CREATE_M15(req, res);
                        // ✅ T44: «Открыть сайт с документом» в браузере по умолчанию
                        // (Яндекс Браузер; референс nak_M_15: puppeteer-core --app + Basic-auth)
                        if (method === 'POST' && p === '/api/transport-oper/open-sz-browser') return await routes.transportOper.POST_OPEN_SZ_BROWSER(req, res);
                        if (method === 'POST' && p === '/api/transport-oper/open-nakl-browser') return await routes.transportOper.POST_OPEN_NAKL_BROWSER(req, res);
                        // ✅ T47: «Удалить СЗ» — GET document_delete.aspx в системе ВАЗ + очистка полей БД
                        if (method === 'POST' && p === '/api/transport-oper/delete-sz') return await routes.transportOper.POST_DELETE_SZ(req, res);
                        // ✅ T39: редактирование текста СЗ (LETTER) через SaveTemplateToPortal
                        if (method === 'GET' && p === '/api/transport-oper/sz-letter') return await routes.transportOper.GET_SZ_LETTER(req, res, url);
                        if (method === 'POST' && p === '/api/transport-oper/save-sz-template') return await routes.transportOper.POST_SAVE_SZ_TEMPLATE(req, res);
                        if (method === 'PUT' && p.match(/^\/api\/transport-oper\/[^/]+$/)) return await routes.transportOper.PUT(req, res, url);
                        if (method === 'DELETE' && p.match(/^\/api\/transport-oper\/[^/]+$/)) return await routes.transportOper.DELETE(req, res, url);
                        // ✅ НОВЫЕ МАРШРУТЫ — добавить позиции и удалить позицию
                        if (method === 'POST' && p === '/api/transport-oper/poz') return await routes.transportOper.POST_POZ(req, res);
                        if (method === 'DELETE' && p.match(/^\/api\/transport-oper\/poz\/[^/]+$/)) return await routes.transportOper.DELETE_POZ(req, res, url);
                }

                // ===== СТАТУСЫ ДЕТАЛЕЙ ПТО =====
                if (p === '/api/detal-status' && method === 'GET') return await routes.detalStatus.GET(req, res, url);
                if (p === '/api/detal-status/all' && method === 'GET') return await routes.detalStatus.GET_ALL(req, res, url);
                if (p === '/api/detal-status' && method === 'POST') return await routes.detalStatus.POST(req, res);
                if (p === '/api/detal-status/batch' && method === 'POST') return await routes.detalStatus.POST_BATCH(req, res);
                if (p.match(/^\/api\/detal-status\/[^/]+$/) && method === 'PUT') return await routes.detalStatus.PUT(req, res, url);
                if (p.match(/^\/api\/detal-status\/[^/]+$/) && method === 'DELETE') return await routes.detalStatus.DELETE(req, res, url);
                
                // ===== EMAIL / ПИСЬМА =====
                if (p === '/api/email/working-days' && method === 'POST') return await routes.email.POST_WORKING_DAYS(req, res);
                if (p === '/api/email/generate-excel' && method === 'POST') return await routes.email.POST_GENERATE_EXCEL(req, res);
                // ✅ T88: просмотр сохранённого файла запроса «Заявка № …xlsx»
                if (p === '/api/email/preview-zayavka' && method === 'POST') return await routes.email.POST_PREVIEW_ZAYAVKA(req, res);
                if (p === '/api/email/send-technolog' && method === 'POST') return await routes.email.POST_SEND_TEHNOLOG(req, res);
                if (p === '/api/email/send-url-problem' && method === 'POST') return await routes.email.POST_SEND_URL_PROBLEM(req, res);   // ✅ T90
                if (p === '/api/email/send-firms' && method === 'POST') return await routes.email.POST_SEND_FIRMS(req, res);
                if (p === '/api/email/firms-email-preview' && method === 'POST') return await routes.email.POST_FIRMS_EMAIL_PREVIEW(req, res);   // ✅ T100: предпросмотр писем контрагентам
                if (p === '/api/email/technolog-email-preview' && method === 'POST') return await routes.email.POST_TEHNOLOG_EMAIL_PREVIEW(req, res);   // ✅ T101: предпросмотр письма технологу
                if (p === '/api/email/update-url' && method === 'POST') return await routes.email.POST_UPDATE_URL(req, res);
                if (p === '/api/email/firm-contacts' && method === 'GET') return await routes.email.GET_FIRM_CONTACTS(req, res, url);
                if (p === '/api/email/finalize-status' && method === 'POST') return await routes.email.POST_FINALIZE_STATUS(req, res);
// ===== ЗАКАЗЫ ПО ДОГОВОРАМ =====

if (p === '/api/orders/positions' && method === 'GET') return await routes.orders.GET_POSITIONS(req, res, url);
if (p === '/api/orders/available' && method === 'GET') return await routes.orders.GET_AVAILABLE_POSITIONS(req, res, url);
if (p === '/api/orders/position' && method === 'POST') return await routes.orders.POST_ADD_POSITION(req, res);
if (p.match(/^\/api\/orders\/[^/]+\/step$/) && method === 'PUT') return await routes.orders.PUT_STEP(req, res, url);
if (p === '/api/orders/position-status' && method === 'PUT') return await routes.orders.PUT_POSITION_STATUS(req, res);
// ✅ T35: массовая смена статуса — применяется ко ВСЕМ позициям заказа
if (p === '/api/orders/positions-status-all' && method === 'PUT') return await routes.orders.PUT_POSITION_STATUS_ALL(req, res);
if (p === '/api/orders/upload-file' && method === 'POST') return await routes.orders.POST_UPLOAD_FILE(req, res, url);
if (p.match(/^\/api\/orders\/position\/[^/]+$/) && method === 'DELETE') return await routes.orders.DELETE_POSITION(req, res, url);
if (p === '/api/orders/generate-excel' && method === 'POST') return await routes.orders.POST_GENERATE_EXCEL(req, res);
// ✅ T26: обработчик письма на согласование заказа перенесён в emailRoutes.js
// (вся работа с письмами в одном месте); URL ПРЕЖНИЙ — клиентских правок не требуется
if (p === '/api/orders/send-email' && method === 'POST') return await routes.email.POST_SEND_EMAIL(req, res);
// ✅ T98: предпросмотр письма на согласование заказа (БЕЗ отправки) —
// тот же конструктор и нормализация адресов, что у реальной отправки
if (p === '/api/orders/email-preview' && method === 'POST') return await routes.email.POST_EMAIL_PREVIEW(req, res);
if (p === '/api/orders/generate' && method === 'POST') return await routes.orders.POST_GENERATE_ORDERS(req, res);
if (p === '/api/orders/dependencies' && method === 'GET')   return await routes.orders.GET_DEPENDENCIES(req, res);

// ===== ЗАКАЗЫ ПО ДОГОВОРАМ =====
if (p === '/api/orders' && method === 'GET') return await routes.orders.GET(req, res, url);
if (p === '/api/orders' && method === 'POST') return await routes.orders.POST(req, res);
if (p.match(/^\/api\/orders\/[^/]+$/) && method === 'PUT') return await routes.orders.PUT(req, res, url);
if (p.match(/^\/api\/orders\/[^/]+$/) && method === 'DELETE') return await routes.orders.DELETE(req, res, url);

// ===== ГЛОБАЛЬНЫЕ ЗАВИСИМОСТИ (СИНТЕТИЧЕСКИЕ ТАБЛИЦЫ) =====
if (p === '/api/synthetic/dependencies' && method === 'GET')   return await routes.synthetic.GET_DEPENDENCIES(req, res);


if (p === '/api/test-virtual-select' && method === 'GET')
  return await routes.testVS.GET(req, res, url);
// ===== Статика =====
      serveStatic(req, res, PUBLIC_DIR);

    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  };
};