/**
 * config.js: everything you might want to change without touching app logic.
 *
 * After deploying the Apps Script web app, paste its URL into SCRIPT_URL.
 * Exam types, sections and topic lists can be edited freely: existing data
 * keeps working because rows store section/topic names as plain text.
 */
window.APP_CONFIG = {
  // Google Apps Script web app URL (ends in /exec). Leave empty for demo mode.
  SCRIPT_URL: '',

  // Exam type pre-selected in the forms, and the dashboard's default filter
  // (so 40-mark sectional tests aren't mixed into the 80-mark mock trend).
  DEFAULT_EXAM_TYPE: 'IBPS RRB PO Prelims',

  // Each exam type lists its sections in the order Guidely shows them.
  // questions × marks = max score. negative = marks deducted per wrong answer.
  // The forms also accept any NEW type name: you tick its sections, and the
  // number of questions can be changed per mock.
  EXAM_TYPES: [
    {
      name: 'IBPS RRB PO Prelims',
      sections: [
        { name: 'Reasoning Ability', questions: 40, marks: 1, negative: 0.25 },
        { name: 'Quantitative Aptitude', questions: 40, marks: 1, negative: 0.25 },
      ],
    },
    {
      name: 'RRB PO Sectional – Quant',
      sections: [{ name: 'Quantitative Aptitude', questions: 40, marks: 1, negative: 0.25 }],
    },
    {
      name: 'RRB PO Sectional – Reasoning',
      sections: [{ name: 'Reasoning Ability', questions: 40, marks: 1, negative: 0.25 }],
    },
    {
      name: 'IBPS RRB Clerk Prelims',
      sections: [
        { name: 'Reasoning Ability', questions: 40, marks: 1, negative: 0.25 },
        { name: 'Quantitative Aptitude', questions: 40, marks: 1, negative: 0.25 },
      ],
    },
    {
      name: 'IBPS / SBI PO Prelims',
      sections: [
        { name: 'English Language', questions: 30, marks: 1, negative: 0.25 },
        { name: 'Quantitative Aptitude', questions: 35, marks: 1, negative: 0.25 },
        { name: 'Reasoning Ability', questions: 35, marks: 1, negative: 0.25 },
      ],
    },
    {
      name: 'IBPS / SBI Clerk Prelims',
      sections: [
        { name: 'English Language', questions: 30, marks: 1, negative: 0.25 },
        { name: 'Quantitative Aptitude', questions: 35, marks: 1, negative: 0.25 },
        { name: 'Reasoning Ability', questions: 35, marks: 1, negative: 0.25 },
      ],
    },
  ],

  // Extra sections offered when typing a new exam type (e.g. a Mains mock).
  EXTRA_SECTIONS: [
    { name: 'General Awareness', questions: 40, marks: 1, negative: 0.25 },
    { name: 'Computer Knowledge', questions: 20, marks: 1, negative: 0.25 },
  ],

  // Short labels used on charts and small screens.
  SECTION_SHORT: {
    'Reasoning Ability': 'Reasoning',
    'Quantitative Aptitude': 'Quant',
    'English Language': 'English',
    'General Awareness': 'GA',
    'Computer Knowledge': 'Computer',
  },

  // Topic names match Guidely's "Know Your Strength & Weakness" table so they
  // can be copied across exactly. Topics used in past entries are added to
  // the form automatically, so this list only sets the starting order.
  TOPICS: {
    'Reasoning Ability': [
      'Puzzles', 'Seating Arrangements', 'Syllogism', 'Equality & Inequality',
      'Coding & Decoding', 'Blood Relations', 'Direction Sense', 'Order and Ranking',
      'Alphabet Series', 'Condition based Number Series', 'Reasoning Misc Questions Mixed',
    ],
    'Quantitative Aptitude': [
      'Data Interpretation', 'Approximation', 'Simplification', 'Quadratic Equation',
      'Number Series', 'Wrong Number Series', 'Quantity I and II', 'Data Sufficiency',
      'Number System', 'Percentage', 'Profit and Loss', 'SI and CI', 'Ratio and Proportion',
      'Partnership', 'Mixture & Alligation', 'Averages', 'Ages', 'Time & Work',
      'Pipes & Cisterns', 'Time & Speed & Distance', 'Trains', 'Boats & Streams',
      'Mensuration', 'Probability',
    ],
    'English Language': [
      'Reading Comprehension', 'Cloze Test', 'Error Detection', 'Para Jumbles', 'Fillers',
      'Sentence Rearrangement', 'Word Swap', 'Phrase Replacement', 'Misc English',
    ],
  },

  // Topic classification on the dashboard. "Score rate" = correct ÷ questions
  // in that topic, so skipped questions count against it, the same way they
  // cost marks in the exam.
  WEAK_BELOW: 0.5,       // score rate below this → weak
  STRONG_ABOVE: 0.8,     // score rate above this → strong
  MIN_MOCKS_FOR_PATTERN: 3, // a topic must appear in at least this many mocks
};
