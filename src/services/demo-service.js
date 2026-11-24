import { AppError } from '../utils/app-error.js';

// Demo accounts for presenting the project. They only exist, and the login
// page only offers them, when the server runs with DEMO_MODE=true.
export const DEMO_PASSWORD = 'MediVault@Demo2026';

export const DEMO_ACCOUNTS = [
  { role: 'patient', name: 'Ananya Rao', email: 'demo.patient@example.com', licenseId: null },
  { role: 'doctor', name: 'Dr. Arjun Mehta', email: 'demo.doctor@example.com', licenseId: 'DEMO-DOC-0001' },
  { role: 'pharmacy', name: 'CityCare Pharmacy', email: 'demo.pharmacy@example.com', licenseId: 'DEMO-PHARM-0001' }
];

const CONSENT_MINUTES = 30;

const DEMO_PROFILE = {
  bloodGroup: 'B+',
  gender: 'female',
  dateOfBirth: '1998-04-12',
  emergencyContactName: 'Ravi Rao',
  emergencyContactPhone: '+91 9876543210',
  emergencyContactRelationship: 'Father',
  allergies: [{ substance: 'Penicillin', reaction: 'Skin rash', severity: 'moderate' }],
  allergiesStatus: 'provided',
  chronicConditions: [{ name: 'Asthma', notes: 'Mild, seasonal' }],
  chronicConditionsStatus: 'provided',
  currentMedications: [],
  medicationsStatus: 'none_known'
};

const DEMO_PRESCRIPTION = {
  title: 'Fever and sore throat',
  diagnosis: 'Acute pharyngitis',
  symptoms: 'Fever for 2 days, sore throat',
  medications: [
    { name: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'Three times a day', duration: '5 days', instructions: 'After food' },
    { name: 'Azithromycin 500 mg', dose: '1 tablet', frequency: 'Once a day', duration: '3 days' }
  ],
  followUp: 'Review if fever continues after 3 days',
  notes: 'Drink plenty of warm fluids.'
};

// A one-page PDF so the demo lab report has a real attachment.
function demoReportPdf() {
  const text = 'MediVault demo lab report - Complete blood count: Hb 12.8 g/dL, WBC 7,200 /uL, Platelets 2.6 lakh /uL. All values in normal range.';
  const stream = `BT /F1 11 Tf 40 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export class DemoService {
  constructor({
    enabled = false,
    database,
    userRepository,
    authService,
    consentService,
    emergencyProfileAccessRequestService,
    emergencyProfileService,
    prescriptionService,
    medicalRecordService,
    log = console
  }) {
    this.enabled = enabled;
    this.database = database;
    this.userRepository = userRepository;
    this.authService = authService;
    this.consentService = consentService;
    this.emergencyProfileAccessRequestService = emergencyProfileAccessRequestService;
    this.emergencyProfileService = emergencyProfileService;
    this.prescriptionService = prescriptionService;
    this.medicalRecordService = medicalRecordService;
    this.log = log;
    this.seeding = null;
  }

  publicAccounts() {
    if (!this.enabled) return { enabled: false, accounts: [] };
    return {
      enabled: true,
      accounts: DEMO_ACCOUNTS.map(({ role, name, email, licenseId }) => ({
        role, name, email, licenseId, password: DEMO_PASSWORD
      }))
    };
  }

  seedInBackground() {
    if (!this.enabled) return;
    this.seed().catch((error) => {
      this.log.error('[demo] Seeding failed:', error?.message || error);
    });
  }

  // Creates the demo accounts and their sample data. Safe to run again: it
  // only adds what is missing.
  seed() {
    if (!this.seeding) {
      this.seeding = this.runSeed().finally(() => {
        this.seeding = null;
      });
    }
    return this.seeding;
  }

  async runSeed() {
    const users = {};
    for (const account of DEMO_ACCOUNTS) {
      users[account.role] = await this.ensureAccount(account);
    }
    const { patient, doctor } = users;

    const [profileDone, prescriptionDone, reportDone] = await Promise.all([
      this.patientIsActive(patient.id),
      this.hasRows('prescriptions', patient.id),
      this.hasRows('medical_records', patient.id)
    ]);

    if (profileDone && prescriptionDone && reportDone) {
      this.log.log('[demo] Demo accounts and sample data are ready.');
      return { created: false };
    }

    await this.ensureConsent(patient.id, doctor.id);

    if (!profileDone) await this.createProfile(patient.id, doctor.id);
    if (!prescriptionDone) await this.createPrescription(patient.id, doctor.id);
    if (!reportDone) await this.createLabReport(patient.id, doctor.id);

    this.log.log('[demo] Demo accounts and sample data are ready.');
    return { created: true };
  }

  async ensureAccount({ role, name, email, licenseId }) {
    let user = await this.userRepository.findByEmail(email);

    if (!user) {
      await this.authService.register({
        name,
        email,
        password: DEMO_PASSWORD,
        role,
        ...(licenseId ? { licenseId } : {})
      });
      user = await this.userRepository.findByEmail(email);
      this.log.log(`[demo] Created ${role} ${email}`);
    }

    if (user.status !== 'active') {
      await this.userRepository.setStatus(user.id, 'active');
    }

    // Signing in makes sure doctors and pharmacies have a signing key.
    if (role !== 'patient') {
      await this.authService.login({ email, password: DEMO_PASSWORD });
    }

    return user;
  }

  async patientIsActive(patientUserId) {
    const user = await this.userRepository.findById(patientUserId);
    return user?.medical_record_status === 'active';
  }

  async hasRows(table, patientUserId) {
    const result = await this.database.query(
      `SELECT 1 FROM ${table} WHERE patient_user_id = $1 LIMIT 1`,
      [patientUserId]
    );
    return result.rows.length > 0;
  }

  async ensureConsent(patientUserId, doctorUserId) {
    try {
      await this.consentService.grant(
        patientUserId,
        doctorUserId,
        new Date(Date.now() + CONSENT_MINUTES * 60 * 1000)
      );
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'CONSENT_EXISTS')) throw error;
    }
  }

  async createProfile(patientUserId, doctorUserId) {
    const request = await this.emergencyProfileAccessRequestService.requestPermission(
      doctorUserId, patientUserId, 'create'
    );
    await this.emergencyProfileAccessRequestService.decide(patientUserId, request.id, 'approved');
    await this.emergencyProfileService.createInitialProfile(
      doctorUserId,
      patientUserId,
      DEMO_PROFILE,
      'Demo: first visit',
      request.id,
      DEMO_PASSWORD
    );
    this.log.log('[demo] Created the basic profile.');
  }

  async createPrescription(patientUserId, doctorUserId) {
    const approval = await this.prescriptionService.requestApproval(doctorUserId, patientUserId);
    await this.prescriptionService.decideApproval(patientUserId, approval.id, 'approved');
    await this.prescriptionService.create(doctorUserId, patientUserId, {
      ...DEMO_PRESCRIPTION,
      approvalId: approval.id,
      password: DEMO_PASSWORD
    });
    this.log.log('[demo] Created the prescription.');
  }

  async createLabReport(patientUserId, doctorUserId) {
    const approval = await this.medicalRecordService.requestRecordCreation(doctorUserId, patientUserId);
    await this.medicalRecordService.decideRecordCreationRequest(patientUserId, approval.id, 'approved');
    const pdf = demoReportPdf();
    await this.medicalRecordService.uploadRecordForDoctor(
      doctorUserId,
      patientUserId,
      {
        form: { findings: 'All blood counts within normal range.' },
        file: { buffer: pdf, originalname: 'cbc-report.pdf', mimetype: 'application/pdf', size: pdf.length }
      },
      { title: 'Complete blood count', category: 'lab-result' },
      approval.id,
      DEMO_PASSWORD
    );
    this.log.log('[demo] Created the lab report.');
  }
}
