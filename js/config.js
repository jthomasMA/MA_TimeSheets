// =====================================================================
// App settings — the only file you need to edit.
// Find your URL and key in Supabase: Project Settings > API.
// (The "anon public" key is meant to be public; the security rules in
//  the database are what protect the data.)
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://lvrmlrasfddmoqladknp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_4mT_vCEzIGe1TJKn0lNC1g_QvWRnO63',

  COMPANY_NAME: 'M-A Building',

  // First day of your pay week: 0 = Sunday, 1 = Monday, ... 6 = Saturday
  WEEK_START_DAY: 1,

  // Weekly hours after which time is flagged as overtime
  OVERTIME_THRESHOLD: 40,

  // Optional cost codes shown as suggestions. Leave empty [] to skip.
  // Example: ['01-100 General Conditions', '03-300 Concrete', '06-100 Framing']
  COST_CODES: [],
};
