const mongoose = require('mongoose');

// Fiókok, ismerősök és felhasználói beállítások.
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 24 },
  nickname: { type: String, required: true, trim: true, maxlength: 40 },
  age: { type: Number, min: 16, max: 120 },
  passwordHash: { type: String, required: true, select: false },
  avatar: { type: String, default: '' },
  bio: { type: String, default: '', maxlength: 240 },
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  settings: {
    theme: { type: String, enum: ['light', 'dark'], default: 'light' },
    language: { type: String, enum: ['hu', 'en'], default: 'hu' },
    notifications: { type: Boolean, default: true }
  }
}, { timestamps: true });

// Bulik, résztvevők és a közösen hozott tételek.
const partySchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 90 },
  coverImage: { type: String, default: '', maxlength: 2048 },
  description: { type: String, default: '', maxlength: 1200 },
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  visibility: { type: String, enum: ['private', 'public'], default: 'private' },
  inviteCode: { type: String, unique: true, sparse: true },
  date: { type: Date, required: true },
  location: { type: String, required: true, trim: true, maxlength: 160 },
  coordinates: {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 }
  },
  ticketPrice: { type: Number, default: 0, min: 0 },
  maxGuests: { type: Number, default: 30, min: 2, max: 1000 },
  members: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, status: { type: String, enum: ['invited', 'going', 'declined'], default: 'invited' } }],
  contributions: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: { type: String, required: true, maxlength: 100 }, quantity: { type: String, default: '1', maxlength: 30 }, price: { type: Number, default: 0, min: 0 }, category: { type: String, enum: ['étel', 'ital', 'egyéb'], default: 'egyéb' }, icon: { type: String, default: '✳', maxlength: 2048 } }]
}, { timestamps: true });

partySchema.index({ visibility: 1, date: 1 });

// Meghívók és barátfelkérések értesítései.
const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  party: { type: mongoose.Schema.Types.ObjectId, ref: 'Party' },
  targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['party-invite', 'party-invite-request', 'friend-request', 'system'], default: 'system' },
  inviteRequestStatus: { type: String, enum: ['pending', 'accepted', 'declined'] },
  message: { type: String, required: true, maxlength: 240 },
  read: { type: Boolean, default: false }
}, { timestamps: true });

// Bulihez tartozó, résztvevők számára látható chatüzenetek.
const partyMessageSchema = new mongoose.Schema({
  party: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 1000 }
}, { timestamps: true });
partyMessageSchema.index({ party: 1, createdAt: -1 });

module.exports = {
  User: mongoose.model('User', userSchema),
  Party: mongoose.model('Party', partySchema),
  Notification: mongoose.model('Notification', notificationSchema),
  PartyMessage: mongoose.model('PartyMessage', partyMessageSchema)
};