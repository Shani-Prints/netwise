/**
 * All user-facing Hebrew copy lives in this file (and nowhere else in src/).
 * Keys are English. Components import from here and contain no inline Hebrew.
 * Strings in square brackets are placeholders that will be replaced by real data or by approved wording.
 */
export const he = {
  common: {
    appName: 'יועץ הרכב',
    appSubtitle: 'שטראוס · שאלות על הרכב והנטו שלך',
    iconLabel: 'יועץ הרכב',
  },

  launcher: {
    open: 'פתיחת יועץ הרכב',
    close: 'סגירת היועץ',
    windowLabel: 'יועץ הרכב – צ׳אט',
    unread: 'יש הודעה חדשה שלא נקראה',
  },

  ask: {
    headline: 'מה תרצה לדעת על הרכב שלך?',
    intro: 'שואלים בחופשיות, ומקבלים השוואה מוסברת לנטו – תוך דקה.',
    fieldLabel: 'השאלה שלך',
    placeholder: 'הקלידו את השאלה שלכם',
    messagesLabel: 'השיחה',
    send: 'שליחת השאלה',
    thinking: 'בודק את הנתונים…',
    chipsLabel: 'או בחרו שאלה נפוצה',
    note: 'החישוב מתבסס על נתוני השכר שלך ועל נוסחאות המס העדכניות. כשאין לי תשובה ודאית, השאלה עוברת לנציג.',
    chips: {
      electric: {
        label: 'מעבר לרכב חשמלי',
        question: 'מה יקרה לנטו שלי אם אעבור לרכב חשמלי?',
      },
      otherCar: {
        label: 'החלפה לרכב אחר',
        question: 'מה יקרה לנטו שלי אם אחליף לרכב אחר?',
      },
      waiver: {
        label: 'ויתור על הרכב',
        question: 'מה יקרה לנטו שלי אם אוותר על הרכב?',
      },
      usageValue: {
        label: 'איך מחושב שווי השימוש?',
        question: 'איך מחושב שווי השימוש?',
      },
    },
  },

  answer: {
    subtitle: 'תשובה מוכנה',
    intro: 'הנה ההשוואה לנטו החודשי שלך, לפי שלוש האפשרויות:',
    table: {
      caption: 'השוואת נטו חודשי בין שלוש האפשרויות',
      rowUsageValue: 'שווי שימוש חודשי',
      rowTaxOnUsage: 'מס וב״ל על השווי',
      rowNetMonthly: 'נטו חודשי',
      rowDelta: 'הפרש מהיום',
      colCurrent: 'הרכב היום',
      colElectric: 'חשמלי',
      colNone: 'בלי רכב',
      notApplicable: 'אין',
      placeholderAmount: '[__]',
    },
    why: {
      title: 'למה זה יוצא כך',
    },
    howWeCalculated: {
      title: 'איך חישבנו',
      confidence: {
        high: 'ודאות גבוהה',
        medium: 'ודאות בינונית',
        low: 'ודאות נמוכה',
      },
    },
    compareOtherCar: 'השווה לרכב אחר',
    anotherQuestion: 'שאלה נוספת',
    talkToRep: 'לא נראה לי נכון? דברו עם נציג',
  },

  handoff: {
    subtitle: 'אין לי תשובה ודאית',
    checkedTitle: 'מה בדקתי',
    checkedOk: 'נבדק',
    checkedMissing: 'חסר',
    whatGoesTitle: 'מה יועבר לנציג',
    whatGoesText: 'השאלה שלך וכל מה שבדקתי. הנציג משיב ליועץ, לא אליך ישירות.',
    notifyLegend: 'איך להתריע לך כשהתשובה מוכנה?',
    channels: {
      push: 'התראה בנייד',
      email: 'מייל',
      sms: 'SMS',
    },
    submit: 'העבר לנציג',
    submitBusy: 'מעביר…',
    submitted: 'הועבר לנציג',
    expectedTime: 'זמן מענה צפוי של הנציג: [SLA] ימי עבודה',
  },

  confirmation: {
    subtitle: 'הפנייה נשלחה',
    title: 'הפנייה הועברה לנציג',
    text: 'התשובה תחזור אליך כאן בצ׳אט. מספר פנייה:',
    step1Title: 'הפנייה התקבלה',
    step1Detail: 'השאלה והבדיקות שלי צורפו',
    step2Title: 'הנציג משיב ליועץ',
    step2Detail: 'בתוך [SLA] ימי עבודה',
    step3Title: 'היועץ מתריע לך',
    step3Detail: {
      push: 'התראה בנייד, והתשובה בצ׳אט',
      email: 'הודעת מייל, והתשובה בצ׳אט',
      sms: 'הודעת SMS, והתשובה בצ׳אט',
    },
    backToChat: 'חזרה לצ׳אט',
  },

  rep: {
    title: 'קונסולת נציג',
    listSubtitle: 'פניות ממתינות למענה',
    listEmpty: 'אין פניות פתוחות.',
    listTicketLabel: 'פנייה {ticketNumber}',
    ticketSubtitle: 'פנייה {ticketNumber} · {status}',
    status: {
      waiting: 'ממתינה למענה',
      needsInfo: 'ממתינה לפרטים נוספים',
      answered: 'נענתה',
    },
    sla: {
      remaining: 'נותרו [SLA]',
      overdue: 'חריגה מה־[SLA]',
    },
    questionLabel: 'השאלה של העובד',
    checkedTitle: 'מה היועץ כבר בדק',
    answerLabel: 'התשובה ליועץ',
    answerPlaceholder: '[כתבו כאן את התשובה והחישוב לעובד]',
    helper: 'היועץ ינסח את התשובה לעובד, יתריע לו ויחזיר אותה בצ׳אט.',
    send: 'שלח ליועץ',
    sendBusy: 'שולח…',
    requestInfo: 'בקש פרטים נוספים',
    sent: 'התשובה נשלחה ליועץ.',
    infoRequested: 'הבקשה לפרטים נוספים נשלחה.',
    backToList: 'חזרה לרשימת הפניות',
    notFound: 'הפנייה לא נמצאה.',
  },

  notification: {
    appName: 'יועץ הרכב',
    title: 'יש תשובה לשאלה שלך',
    body: 'הנציג השיב על ״{question}״. לחצו לצפייה בצ׳אט.',
    timeNow: 'עכשיו',
  },

  returned: {
    subtitle: 'תשובה מהנציג',
    repRepliedAt: 'הנציג השיב ליועץ · {time}',
    intro: 'יש תשובה לשאלה שלך. הנציג בדק את ההסדר המיוחד שלך וזה התוצאה:',
    rowNetToday: 'נטו חודשי היום',
    rowNetWithElectric: 'נטו חודשי עם רכב חשמלי',
    rowDelta: 'הפרש',
    approvedBy: 'אושר על ידי נציג · {team}',
    helpful: 'זה עזר',
    anotherQuestion: 'שאלה נוספת',
  },

  /** Demo copy used by the mock fixtures. Replace with real data when the API layer exists. */
  demo: {
    handoffQuestion: 'אני בהסדר רכב מיוחד. מה יקרה לנטו אם אעבור לחשמלי?',
    handoffBotMessage:
      'לא מצאתי תשובה מהימנה לשאלה הזו, ואני לא רוצה לנחש כשמדובר בשכר שלך. אעביר אותה לנציג והוא ישיב לי. אחזיר לך את התשובה כאן בצ׳אט ואתריע לך כשהיא מוכנה.',
    checkedElectricFormula: 'נוסחת שווי השימוש לרכב חשמלי',
    checkedSalaryData: 'נתוני השכר והזיכוי שלך',
    checkedSpecialArrangement: 'תנאי ההסדר המיוחד שלך – לא זמינים לי',
    repCheckedSpecialArrangement: 'תנאי ההסדר המיוחד: חסר, נדרשת בדיקה שלך',
    reasons: [
      'שווי השימוש של הרכב מתווסף לשכר החייב במס, ולכן מקטין את הנטו.',
      'לרכב חשמלי יש הטבה בחישוב שווי השימוש. גובה ההטבה נקבע לפי הנוסחה העדכנית.',
      'בלי רכב אין שווי שימוש, אבל גם אין את הרכב עצמו. ההפרש מוצג לעומת מצבך היום.',
    ],
    sources:
      'שכר ברוטו ונקודות זיכוי: [מערכת השכר]. מחירון הרכב: [מקור]. נוסחאות מס: [שנת מס]. עודכן ב[תאריך].',
    usageTaxDefinitionPlaceholder: '[הגדרת ״מס וב״ל על השווי״ – ממתינה לאישור מחלקת השכר]',
    repExplanation: '[ההסבר של הנציג, בנוסח היועץ]',
    teamName: '[שם הצוות]',
    timeLabel: '[שעה]',
    ticketNumber: '[#]',
  },
} as const;

export type Copy = typeof he;
