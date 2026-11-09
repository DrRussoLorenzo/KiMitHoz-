const mongoose = require('mongoose');

// Fiókok, ismerősök és felhasználói beállítások.
// A select: false mezők alapból rejtve maradnak, például a jelszóhash és az igazoló dokumentumok.
const felhasznaloAdatSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
    },
    nickname: { type: String, required: true, trim: true, maxlength: 40 },
    role: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: '', maxlength: 240 },
    bannedAt: { type: Date },
    age: { type: Number, min: 16, max: 120 },
    birthDate: { type: Date, select: false },
    verificationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
    },
    verificationReviewedAt: { type: Date },
    verificationDocuments: {
      identityDocument: { type: String, select: false },
      facePhoto: { type: String, select: false },
    },
    passwordHash: { type: String, required: true, select: false },
    avatar: { type: String, default: '' },
    bio: { type: String, default: '', maxlength: 240 },
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    settings: {
      theme: { type: String, enum: ['light', 'dark'], default: 'light' },
      language: { type: String, enum: ['hu', 'en', 'de'], default: 'hu' },
      notifications: { type: Boolean, default: true },
      colors: {
        primary: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
        accent: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
        background: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
        selection: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
      },
    },
  },
  { timestamps: true }
);
felhasznaloAdatSchema.index(
  { role: 1 },
  { unique: true, partialFilterExpression: { role: 'admin' } }
);

// Bulik, résztvevők és a közösen hozott tételek.
// A résztvevők és a felajánlott tételek az adott bulihoz kapcsolódó listák.
const esemenyAdatSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 90 },
    coverImage: { type: String, default: '', maxlength: 2048 },
    description: { type: String, default: '', maxlength: 1200 },
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    visibility: { type: String, enum: ['private', 'public'], default: 'private' },
    inviteCode: { type: String, unique: true, sparse: true },
    date: { type: Date, required: true },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date },
    galleryImages: [
      {
        filename: { type: String, select: false },
        format: { type: String, select: false },
        version: { type: Number, select: false },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    location: { type: String, required: true, trim: true, maxlength: 160 },
    coordinates: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },
    ticketPrice: { type: Number, default: 0, min: 0 },
    minAge: { type: Number, default: 16, min: 16, max: 120 },
    maxGuests: { type: Number, default: 30, min: 2, max: 1000 },
    members: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['invited', 'going', 'declined'], default: 'invited' },
      },
    ],
    contributions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: { type: String, required: true, maxlength: 100 },
        quantity: { type: String, default: '1', maxlength: 30 },
        price: { type: Number, default: 0, min: 0 },
        category: { type: String, enum: ['étel', 'ital', 'egyéb'], default: 'egyéb' },
        icon: { type: String, default: '✳', maxlength: 2048 },
      },
    ],
  },
  { timestamps: true }
);

esemenyAdatSchema.index({ visibility: 1, date: 1 });

// Meghívók és barátfelkérések értesítései.
const ertesitesAdatSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    party: { type: mongoose.Schema.Types.ObjectId, ref: 'Party' },
    partyMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'PartyMessage' },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: {
      type: String,
      enum: ['party-invite', 'party-invite-request', 'friend-request', 'party-mention', 'system'],
      default: 'system',
    },
    inviteRequestStatus: { type: String, enum: ['pending', 'accepted', 'declined'] },
    message: { type: String, required: true, maxlength: 240 },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);
// A type mező határozza meg, milyen eseményről szól az értesítés.

// Bulihoz tartozó, résztvevők számára látható chatüzenetek.
const chatUzenetAdatSchema = new mongoose.Schema(
  {
    party: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    mentionedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);
chatUzenetAdatSchema.index({ party: 1, createdAt: -1 });
// A party és sender mezők az üzenetet a bulihoz és annak írójához kapcsolják.

// Adminisztrátori módosítások naplója; kérésadatok és személyes tartalmak nélkül.
const adminNaploAdatSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    method: { type: String, enum: ['POST', 'PATCH', 'PUT', 'DELETE'], required: true },
    action: {
      type: String,
      enum: ['create', 'update', 'delete', 'approve', 'reject', 'ban', 'unban'],
      default: 'update',
    },
    description: { type: String, default: '', maxlength: 600 },
    resource: { type: String, required: true, maxlength: 80 },
    resourceId: { type: String, default: '', maxlength: 80 },
    resourceName: { type: String, default: '', maxlength: 240 },
    statusCode: { type: Number, required: true },
  },
  { timestamps: true }
);
adminNaploAdatSchema.index({ createdAt: -1 });
// Csak a művelet követéséhez szükséges leíró adatokat tároljuk.

module.exports = {
  User: mongoose.model('User', felhasznaloAdatSchema),
  Party: mongoose.model('Party', esemenyAdatSchema),
  Notification: mongoose.model('Notification', ertesitesAdatSchema),
  PartyMessage: mongoose.model('PartyMessage', chatUzenetAdatSchema),
  AdminAuditLog: mongoose.model('AdminAuditLog', adminNaploAdatSchema),
};
