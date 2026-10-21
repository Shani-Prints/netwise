/**
 * Texts the server writes into the conversation about the payslip. The marker is a system message created ONLY by the server when
 * the confirmed payslip values were really saved. It carries no value, no file name and no file content, and it is never written
 * by a client message. The UI shows it on the employee's side as a small chip; it is not an employee message (role "system"), so the
 * provenance check never counts it.
 */
export const PAYSLIP_MARKER_TEXT = 'צורף תלוש שכר ואושרו הנתונים';

/** One-time offer, appended by the server to the first bot message that asks for pay data. Short and gender-neutral. */
export const PAYSLIP_OFFER_TEXT = 'אפשר גם לצרף תלוש שכר במקום להקליד. לא חובה, והקובץ לא נשמר במערכת.';
