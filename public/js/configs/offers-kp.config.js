// ============================================================
// public/js/configs/offers-kp.config.js
// КОНФИГ: Коммерческое предложение — единый источник истины
// ============================================================
export default {
  entity: 'kp',
  apiUrl: '/api/kom-predl',
  idKey: 'id',
  tableTitle: 'Коммерческое предложение',
  wsSync: false, // Управляется вручную через initSyntheticSync в app-offers.js

  fields: [
    {
      key: 'trudoemkost_postavshika',
      label: 'Трудоемкость, н/ч',
      domId: 'kpTrudoemkost',
      type: 'text',
      required: false,
    },{
      key: 'cena_postavshika',
      label: 'Цена дет. без НДС, ₽',
      domId: 'kpCena',
      type: 'text',
      required: false,
    },{
      key: 'moshchnost_kolvo',
      label: 'Мощность, шт',
      domId: 'kpMoshchnost',
      type: 'text',
      required: false,
    },{
      key: 'srok_vipolneniya',
      label: 'Срок выполнения, дн.',
      domId: 'kpSrok',
      type: 'text',
      required: false,
    },{
      domId: 'kpCenaNCh',          // ID элемента в HTML
      key: 'cena_n_ch',            // Ключ (для единообразия, хотя на сервер не уйдет)
      type: 'text',                // Тип поля
      virtual: true,               // ✅ ГЛАВНОЕ: не отправляется на сервер (buildPayload игнорирует)
      skipDirty: true,             // ✅ ГЛАВНОЕ: не участвует в проверке изменений формы
      default: '',                 // ✅ Значение по умолчанию (будет использовано в clearForm)
      label: 'Цена нормо-часа',    // Для сообщений об ошибках (если вдруг понадобятся)
      readonly: true               // Делаем поле визуально и программно недоступным для ручного ввода
    },{
      key: 'tip_izgotovleniya',
      label: 'Тип изготовления',
      domId: 'kpTipIzgot',
      type: 'select',
      required: true,
      options: [
        'ПОЛНЫЙ ЦИКЛ (ТО + МЕХ. ОБРАБОТКА)',
        'ПОЛНАЯ МЕХ ОБРАБОТКА БЕЗ ТО',
        'ЧАСТИЧНАЯ МЕХ ОБРАБОТКА С ТО',
        'ЧАСТИЧНАЯ МЕХ ОБРАБОТКА БЕЗ ТО',
      ],
    },{
      key: 'id_dogovor',
      label: 'Договор',
      domId: 'kpDogovor',
      type: 'select',
      required: false,
    },
  ],
};