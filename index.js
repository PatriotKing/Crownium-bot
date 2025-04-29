// index.js
console.log('⚙️ index.js loaded at ' + new Date().toISOString());
require('dotenv').config();

const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const express = require('express');

// 1) Reply-keyboard menu layout
const mainMenu = [
  [ { text: 'Click' },     { text: 'Balance' } ],
  [ { text: 'Task' },      { text: 'Withdraw' } ],
  [ { text: 'Invite' },    { text: 'Leaderboard' } ],
  [ { text: 'Me' } ]
];

// 2) Initialize Telegram bot & MongoDB client
const bot = new Telegraf(process.env.BOT_TOKEN);
const client = new MongoClient(process.env.MONGODB_URI);

async function init() {
  try {
    // 3) Connect to MongoDB
    await client.connect();
    console.log('✅ MongoDB connected');
    const users = client.db('crowniumDB').collection('users');

    // 4) Daily reset of click counts at midnight SAST (22:00 UTC)
    cron.schedule('0 22 * * *', async () => {
      await users.updateMany({}, { $set: { daily_click_count: 0 } });
      console.log('🕒 Daily clicks reset at', new Date().toLocaleString('en-ZA'));
    });

    // 5) Express server for CPA webhook callbacks
    const app = express();
    app.use(express.json());
    app.post('/webhook/offer-complete', async (req, res) => {
      const { userId, crowniumReward } = req.body;
      await users.updateOne(
        { user_id: userId },
        { $inc: { total_task_crownium: crowniumReward, tasks_completed_count: 1 } }
      );
      console.log(`✅ Credited ${crowniumReward} CRM to ${userId}`);
      res.sendStatus(200);
    });
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🌐 Webhook listening on port ${PORT}`));

    // 6) /start handler: register or update user, show menu
    bot.start(async ctx => {
      console.log('🛠️ /start invoked');
      const id = ctx.from.id;
      const payload = ctx.startPayload;
      const now = new Date();

      let user = await users.findOne({ user_id: id });
      if (user) {
        // Existing user: update username/first_name
        await users.updateOne(
          { user_id: id },
          { $set: { username: ctx.from.username || null, first_name: ctx.from.first_name || null } }
        );
      } else {
        // New user setup
        user = {
          user_id: id,
          username: ctx.from.username || null,
          first_name: ctx.from.first_name || null,
          last_name: ctx.from.last_name || null,
          joined_at: now,
          daily_click_count: 0,
          total_click_crownium: 0,
          tasks_completed_count: 0,
          total_task_crownium: 0,
          referrer_id: null,
          referral_count: 0,
          referred_at: null,
          click_streak_days: 0,
          is_eligible_for_payout: false,
          locale: ctx.from.language_code || 'en',
          timezone: null
        };
        // Handle referral payload
        if (payload && !isNaN(payload) && parseInt(payload) !== id) {
          const refId = parseInt(payload);
          const refUser = await users.findOne({ user_id: refId });
          if (refUser) {
            user.referrer_id = refId;
            user.referred_at = now;
            await users.updateOne({ user_id: refId }, { $inc: { referral_count: 1 } });
          }
        }
        await users.insertOne(user);
        console.log(`🆕 Registered user ${id}`);
      }

      // Send welcome message with persistent menu
      await ctx.reply(
        `Welcome, ${ctx.from.first_name}! 🎉\nUse the menu below to interact.`,
        {
          reply_markup: {
            keyboard: mainMenu,
            resize_keyboard: true,
            one_time_keyboard: false
          }
        }
      );
    });

    // 7) Click handler
    bot.hears('Click', async ctx => {
      const id = ctx.from.id;
      const user = await users.findOne({ user_id: id });
      if (!user) return ctx.reply('❌ Please send /start first.');
      if (user.daily_click_count >= 500) return ctx.reply('⚠️ 500 clicks/day max reached.');

      // Calculate reward
      let reward = 10;
      const now = new Date();
      if (user.referred_at && (now - new Date(user.referred_at)) <= 2 * 24 * 3600 * 1000) {
        reward = Math.floor(reward * 1.05);
      }
      if (user.referral_count > 0) {
        reward = Math.floor(reward * (1 + 0.1 * user.referral_count));
      }

      // Update database
      await users.updateOne(
        { user_id: id },
        {
          $inc: { total_click_crownium: reward, daily_click_count: 1 },
          $set: { last_click_timestamp: now }
        }
      );
      const updated = await users.findOne({ user_id: id });
      ctx.reply(`⛏️ Click registered! (${updated.daily_click_count}/500) +${reward} CRM.`);
    });

    // 8) Balance handler
    bot.hears('Balance', async ctx => {
      const id = ctx.from.id;
      const user = await users.findOne({ user_id: id });
      if (!user) return ctx.reply('❌ Please send /start first.');
      const total = user.total_click_crownium + user.total_task_crownium;
      const zar = (total / 100).toFixed(2);
      ctx.reply(`👑 You have ${total} CRM = R${zar}`);
    });

    // 9) Task handler
    bot.hears('Task', ctx => {
      const uid = ctx.from.id;
      const url = `https://your-cpa-network.com/offer?uid=${uid}`;
      ctx.reply(`🛠️ Complete this offer: ${url}`);
    });

    // 10) Invite handler
    bot.hears('Invite', ctx => {
      const uname = ctx.botInfo.username;
      ctx.reply(`🔗 Invite link: https://t.me/${uname}?start=${ctx.from.id}`);
    });

    // 11) Leaderboard handler
    bot.hears('Leaderboard', async ctx => {
      const top = await users.find().sort({ referral_count: -1 }).limit(5).toArray();
      let msg = '🏆 Top Referrers:\n';
      top.forEach((u, i) => {
        const name = u.username ? `@${u.username}` : (u.first_name || 'Unknown');
        msg += `${i + 1}. ${name} — ${u.referral_count}\n`;
      });
      ctx.reply(msg);
    });

    // 12) Me handler (inspect your record)
    bot.hears('Me', async ctx => {
      const id = ctx.from.id;
      const u = await users.findOne({ user_id: id });
      ctx.reply(
        `Your record:\n${JSON.stringify({
          user_id: u.user_id,
          username: u.username,
          name: u.first_name,
          referrals: u.referral_count
        }, null, 2)}`
      );
    });

    // 13) Withdraw handler
    bot.hears('Withdraw', async ctx => {
      const id = ctx.from.id;
      const u = await users.findOne({ user_id: id });
      if (!u) return ctx.reply('❌ Please send /start first.');
      const ok = u.tasks_completed_count >= 2 &&
                 (u.total_click_crownium + u.total_task_crownium) >= 500000 &&
                 u.click_streak_days >= 24;
      if (!ok) return ctx.reply('🚫 You are not eligible for withdrawal yet.');
      await users.updateOne({ user_id: id }, { $set: { is_eligible_for_payout: true } });
      ctx.reply('✅ You are in the next payout window.');
    });

    // 14) Launch bot
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Bot is up and running');

  } catch (err) {
    console.error('❌ Initialization failed:', err);
  }
}

// 15) Start the bot
init();

// 16) Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'))
