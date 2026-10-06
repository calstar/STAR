import type { ScrapedRecord } from "@/lib/finance/callink-import";

// A made-up CalLink record shaped like callink-worker's scrape output, with the
// form's real question labels and no real person's details.
export function scrapedRecord(overrides: Partial<ScrapedRecord["list"]> = {}): ScrapedRecord {
  return {
    scrapedAt: "2026-10-02T07:00:00.000Z",
    list: {
      id: 1800001,
      requestNumber: 1860001,
      name: "Ada Lovelace - LE3 - Fittings",
      status: "Approved",
      currentStepName: "Stage 5",
      submittedByName: "Ada Lovelace",
      submittedAmount: 123.45,
      submittedOn: "2026-05-01T12:00:00+00:00",
      approvedAmount: 123.45,
      deletedOn: null,
      ...overrides,
    },
    detail: {
      subject: overrides.name ?? "Ada Lovelace - LE3 - Fittings",
      description: "Fittings for the cold-flow stand",
      financeCategory: { name: "Reimbursement" },
      financeStage: { name: "Stage 5" },
      payee: { firstName: "Ada", lastName: "Lovelace", street: "1 Analytical Way", street2: "Apt 2", city: "Berkeley", state: "CA", zipCode: "94704" },
      submitted: { communityMemberDisplayName: "Ada Lovelace", email: "Ada@Berkeley.edu" },
    },
    answers: [
      { question: "Instructions for completing this purchase request are available in the", answer: "" },
      {
        question: "1. Is payee a UC Berkeley Student or Faculty/Staff Member?",
        answer: "YES, input their Unique ID (UID) number found at https://www.berkeley.edu/directory/ or on CalCentral. (NOTE: UIDs ≠ SIDs that begin with 303. DO NOT use the payee’s student ID or social security number) 7654321",
      },
      { question: "2. REQUIRED: Payee's Email Address (Contact information is required in case of follow up", answer: "ada@berkeley.edu" },
      { question: "3. REQUIRED: Payee's Phone Number (Contact information is required in case of follow up", answer: "5105550100" },
      { question: "4. Expenditure Action", answer: "Direct Deposit - Answer Question 6." },
      { question: "5. SPECIAL INSTRUCTIONS: Provide explanation for amount differences", answer: null },
      { question: "6. Direct Deposit If you are not requesting payment by Direct Deposit, please skip question 6.", answer: "Payee has already successfully completed the direct deposit sign up form" },
      { question: "Item #1: Date of Expense (Include date of transaction, date of service provided", answer: "5/1/2026" },
    ],
    items: [
      {
        item: 1, date: "5/1/2026", type: "Supplies", vendor: "McMaster-Carr", location: "Berkeley, CA", invoice: "INV-1",
        total: "$100.00", notes: null,
        receipt: [{ name: "mcmaster.pdf", href: "/actionCenter/organization/STAR/Finance/FileUploadQuestion/getdocument?DocumentId=11&RespondentId=22", documentId: "11" }],
      },
      { item: 2, date: "5/1/2026", type: "Supplies", vendor: "Swagelok", location: "Berkeley, CA", invoice: null, total: "23.45", notes: "Tax included", receipt: [] },
      { item: 3, date: null, type: "Supplies", vendor: "Bank", location: null, invoice: null, total: "N/A", notes: "statement", receipt: [] },
    ],
  };
}
