require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");

const express = require("express");
const fs      = require("fs");
const path    = require("path");

// ========== ตรวจสอบ Secrets / Env ==========
const TOKEN             = process.env.DISCORD_TOKEN;
const LEAVE_LOG_ID      = process.env.LEAVE_LOG_ID     || "1500744742181277807";
const MEMBER_LOG_ID     = process.env.MEMBER_LOG_ID;
const ADMIN_BACKUP_ID   = process.env.ADMIN_BACKUP_ID;
const MEMBER_ROLE_ID    = "1500588395330666658";
const PORT              = process.env.PORT || 3000;

if (!TOKEN) {
  console.error("❌ ไม่พบ DISCORD_TOKEN — กรุณาตั้งค่า Secret ให้ถูกต้อง");
  process.exit(1);
}

// ========== Counter (บันทึกลงไฟล์) ==========
const COUNTER_FILE = path.join(__dirname, "counter.json");

function loadCounter() {
  try { return JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8")); }
  catch { return { member: 0 }; }
}
function saveCounter(data) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(data, null, 2));
}
function nextMemberNumber() {
  const data = loadCounter();
  data.member += 1;
  saveCounter(data);
  return data.member;
}
function resetMemberCounter() {
  saveCounter({ member: 0 });
}

// ========== In-memory: เก็บ messageId ทั้ง 2 ห้องต่อ userId ==========
// { userId: { mainMsgId, backupMsgId } }
const memberMessages = new Map();

// ========== Express Web Server ==========
const app = express();

app.get("/", (_req, res) => res.send("🤖 Discord Bot กำลังทำงานอยู่ครับ!"));
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    bot: client.isReady() ? "online" : "connecting",
    uptime: Math.floor(process.uptime()) + "s",
    memberCount: loadCounter().member,
  })
);
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🌐 Web Server ทำงานบน port ${PORT}`)
);

// ========== Discord Client ==========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("clientReady", (c) => {
  console.log(`✅ บอทออนไลน์แล้ว! เข้าสู่ระบบในชื่อ: ${c.user.tag}`);
  console.log(`📋 LEAVE_LOG_ID    : ${LEAVE_LOG_ID}`);
  console.log(`👥 MEMBER_LOG_ID   : ${MEMBER_LOG_ID ?? "ไม่ได้ตั้งค่า"}`);
  console.log(`📦 ADMIN_BACKUP_ID : ${ADMIN_BACKUP_ID ?? "ไม่ได้ตั้งค่า"}`);
  console.log(`🏅 MEMBER_ROLE_ID  : ${MEMBER_ROLE_ID}`);
});

// ========== Helpers ==========

function buildLeaveAdminButtons(requesterId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`leave_approve_${requesterId}`)
      .setLabel("อนุมัติ").setStyle(ButtonStyle.Success).setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`leave_reject_${requesterId}`)
      .setLabel("ปฏิเสธ").setStyle(ButtonStyle.Danger).setEmoji("❌")
  );
}

// ห้องหลัก: ปุ่ม "รับรู้แล้ว" (เขียว) + "ปฏิเสธ" (แดง)
function buildMemberAdminButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`member_ack_${userId}`)
      .setLabel("รับรู้แล้ว").setStyle(ButtonStyle.Success).setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`member_revoke_${userId}`)
      .setLabel("ปฏิเสธ").setStyle(ButtonStyle.Danger).setEmoji("❌")
  );
}

async function markMessageDone(message, adminUser, label) {
  const updatedEmbed = EmbedBuilder.from(message.embeds[0])
    .setColor(0x0066ff)
    .setFooter({
      text: `${label} • ดำเนินการแล้วโดย: ${adminUser.tag}`,
      iconURL: adminUser.displayAvatarURL({ size: 64 }),
    });
  await message.edit({ embeds: [updatedEmbed], components: [] });
}

async function sendDM(userId, embed) {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    return true;
  } catch {
    console.warn(`⚠️  ส่ง DM ไปหา ${userId} ไม่ได้`);
    return false;
  }
}

// อัปเดต Embed สีเทา + ลบปุ่ม — ใช้กับทั้ง 2 ห้อง
async function revokeUpdateEmbed(channelId, msgId, revokeReason, adminUser) {
  if (!channelId || !msgId) return;
  try {
    const ch  = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(msgId);
    const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
      .setColor(0x95a5a6)
      .setFooter({
        text: `❌ ปฏิเสธโดยแอดมิน เนื่องจาก: ${revokeReason} • โดย: ${adminUser.tag}`,
        iconURL: adminUser.displayAvatarURL({ size: 64 }),
      });
    await msg.edit({ embeds: [updatedEmbed], components: [] });
  } catch (err) {
    console.error(`ไม่สามารถอัปเดต Embed (channel ${channelId}): ${err.message}`);
  }
}

// ========== Interaction Handler ==========
client.on("interactionCreate", async (interaction) => {

  // ───────────────────────────────────────────
  //  /setup — ระบบแจ้งลา
  // ───────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setColor(0x0066ff)
      .setTitle("📋 ระบบแจ้งลาด่วน")
      .setDescription("กดปุ่มด้านล่างเพื่อกรอกแบบฟอร์มขอลา\nทีมงานจะได้รับการแจ้งเตือนทันที")
      .addFields(
        { name: "⏰ เวลาทำการ",    value: "แจ้งลาได้ตลอด 24 ชั่วโมง",    inline: true },
        { name: "📣 ช่องแจ้งเตือน", value: "ข้อมูลจะถูกส่งไปยังแอดมิน", inline: true }
      )
      .setFooter({ text: "ระบบแจ้งลาอัตโนมัติ • กรุณากรอกข้อมูลให้ถูกต้อง" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_leave_modal")
        .setLabel("แจ้งลาด่วน").setStyle(ButtonStyle.Primary).setEmoji("📝")
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
  }

  // ───────────────────────────────────────────
  //  /setup2 — ระบบสมาชิกใหม่
  // ───────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "setup2") {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setColor(0x0066ff)
      .setTitle("✗iCDIE : กรอกข้อมูลส่วนตัว")
      .addFields(
        { name: "📋 ข้อมูลที่ต้องกรอก", value: "ชื่อ Roblox • ชื่อเล่น/อายุ • ชื่อ IC • เวลาว่าง • อุปกรณ์", inline: false }
      )
      .setFooter({ text: "ระบบสมาชิกใหม่ • กรุณากรอกข้อมูลให้ครบถ้วน" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_member_modal")
        .setLabel("กรอกข้อมูล").setStyle(ButtonStyle.Primary).setEmoji("📋")
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
  }

  // ───────────────────────────────────────────
  //  /resetcounter — รีเซ็ตลำดับ
  // ───────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "resetcounter") {
    resetMemberCounter();
    await interaction.reply({
      content: "✅ รีเซ็ตลำดับสมาชิกเป็น 0 เรียบร้อยแล้วครับ สมาชิกคนถัดไปจะได้ลำดับที่ 1",
      flags: MessageFlags.Ephemeral,
    });
  }

  // ─────────────────────────────────────────
  // Button: เปิด Modal ใบลา
  // ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_leave_modal") {
    const modal = new ModalBuilder()
      .setCustomId("leave_form_modal").setTitle("กรอกแบบฟอร์มขอลา");

    modal.addComponents(
      ...[
        new TextInputBuilder().setCustomId("game_name").setLabel("ชื่อเกม Roblox")
          .setStyle(TextInputStyle.Short).setPlaceholder("กรอกชื่อเกม Roblox ที่คุณเล่น")
          .setRequired(true).setMaxLength(100),
        new TextInputBuilder().setCustomId("nickname").setLabel("ชื่อเล่น")
          .setStyle(TextInputStyle.Short).setPlaceholder("กรอกชื่อเล่นของคุณ")
          .setRequired(true).setMaxLength(50),
        new TextInputBuilder().setCustomId("leave_date").setLabel("ช่วงวันที่ลา")
          .setStyle(TextInputStyle.Short).setPlaceholder("เช่น 10/06/2568 - 12/06/2568")
          .setRequired(true).setMaxLength(100),
        new TextInputBuilder().setCustomId("leave_reason").setLabel("เหตุผลที่ขอลา")
          .setStyle(TextInputStyle.Paragraph).setPlaceholder("กรอกเหตุผลที่ขอลา...")
          .setRequired(true).setMaxLength(500),
      ].map((f) => new ActionRowBuilder().addComponents(f))
    );

    await interaction.showModal(modal);
  }

  // ─────────────────────────────────────────
  // Button: เปิด Modal สมาชิกใหม่
  // ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_member_modal") {
    const modal = new ModalBuilder()
      .setCustomId("member_form_modal").setTitle("กรอกข้อมูลส่วนตัว");

    modal.addComponents(
      ...[
        new TextInputBuilder().setCustomId("roblox_name").setLabel("ชื่อ Roblox")
          .setStyle(TextInputStyle.Short).setPlaceholder("กรอก Username Roblox ของคุณ")
          .setRequired(true).setMaxLength(50),
        new TextInputBuilder().setCustomId("nickname_age").setLabel("ชื่อเล่น/อายุ")
          .setStyle(TextInputStyle.Short).setPlaceholder("เช่น โอม / 18 ปี")
          .setRequired(true).setMaxLength(50),
        new TextInputBuilder().setCustomId("ic_name").setLabel("ชื่อ IC")
          .setStyle(TextInputStyle.Short).setPlaceholder("กรอกชื่อตัวละคร IC ของคุณ")
          .setRequired(true).setMaxLength(100),
        new TextInputBuilder().setCustomId("free_time").setLabel("เวลาว่าง")
          .setStyle(TextInputStyle.Short).setPlaceholder("เช่น 18:00 - 23:00 น. ทุกวัน")
          .setRequired(true).setMaxLength(100),
        new TextInputBuilder().setCustomId("device").setLabel("อุปกรณ์ที่ใช้เล่น")
          .setStyle(TextInputStyle.Short).setPlaceholder("เช่น PC / Mobile / Console")
          .setRequired(true).setMaxLength(50),
      ].map((f) => new ActionRowBuilder().addComponents(f))
    );

    await interaction.showModal(modal);
  }

  // ─────────────────────────────────────────
  // Modal Submit: ใบลา → LEAVE_LOG_ID
  // ─────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "leave_form_modal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const gameName    = interaction.fields.getTextInputValue("game_name");
    const nickname    = interaction.fields.getTextInputValue("nickname");
    const leaveDate   = interaction.fields.getTextInputValue("leave_date");
    const leaveReason = interaction.fields.getTextInputValue("leave_reason");
    const requesterId = interaction.user.id;

    let leaveChannel;
    try {
      leaveChannel = await client.channels.fetch(LEAVE_LOG_ID);
    } catch {
      await interaction.editReply({ content: `❌ ไม่พบช่องแจ้งลา (LEAVE_LOG_ID: ${LEAVE_LOG_ID})` });
      return;
    }

    const notifyEmbed = new EmbedBuilder()
      .setColor(0x0066ff)
      .setTitle("🔔 มีการแจ้งลาใหม่! — รอการอนุมัติ")
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 128 }))
      .addFields(
        { name: "👤 ผู้แจ้ง (Discord)", value: `${interaction.user} (${interaction.user.tag})`, inline: false },
        { name: "🎮 ชื่อเกม Roblox",   value: gameName,    inline: true },
        { name: "📛 ชื่อเล่น",          value: nickname,    inline: true },
        { name: "📅 ช่วงวันที่ลา",      value: leaveDate,   inline: false },
        { name: "📝 เหตุผลที่ขอลา",     value: leaveReason, inline: false }
      )
      .setFooter({ text: `เซิร์ฟเวอร์: ${interaction.guild?.name ?? "DM"} • แจ้งเมื่อ` })
      .setTimestamp();

    await leaveChannel.send({
      embeds: [notifyEmbed],
      components: [buildLeaveAdminButtons(requesterId)],
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x0066ff)
          .setTitle("✅ ส่งคำขอลาเรียบร้อยแล้ว!")
          .setDescription("ข้อมูลของคุณถูกส่งไปยังทีมแอดมินแล้ว รอการตอบกลับด้วยนะครับ 😊")
          .addFields(
            { name: "🎮 ชื่อเกม",  value: gameName,  inline: true },
            { name: "📛 ชื่อเล่น", value: nickname,  inline: true },
            { name: "📅 วันที่ลา", value: leaveDate, inline: false }
          )
          .setTimestamp(),
      ],
    });
  }

  // ─────────────────────────────────────────
  // Modal Submit: สมาชิกใหม่ → MEMBER_LOG_ID + ADMIN_BACKUP_ID + Auto-Role
  // ─────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "member_form_modal") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const robloxName  = interaction.fields.getTextInputValue("roblox_name");
    const nicknameAge = interaction.fields.getTextInputValue("nickname_age");
    const icName      = interaction.fields.getTextInputValue("ic_name");
    const freeTime    = interaction.fields.getTextInputValue("free_time");
    const device      = interaction.fields.getTextInputValue("device");
    const userId      = interaction.user.id;

    // ── 1. แจกยศทันที ──
    let roleAdded = false;
    try {
      const member = interaction.member ?? await interaction.guild.members.fetch(userId);
      await member.roles.add(MEMBER_ROLE_ID);
      roleAdded = true;
      console.log(`🏅 แจกยศให้ ${interaction.user.tag} สำเร็จ`);
    } catch (err) {
      console.error(`❌ แจกยศไม่สำเร็จ: ${err.message}`);
    }

    // ── 2. สร้าง Embed ──
    const memberNo   = nextMemberNumber();
    const roleStatus = roleAdded ? "✅ มอบยศแล้ว" : "⚠️ มอบยศไม่สำเร็จ (แอดมินตรวจสอบด้วย)";
    const guildName  = interaction.guild?.name ?? "DM";

    // Embed เต็ม (ห้องหลัก)
    const memberEmbed = new EmbedBuilder()
      .setColor(0x0066ff)
      .setTitle("📋 ข้อมูลสมาชิกใหม่")
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 128 }))
      .addFields(
        { name: "👤 Discord",        value: `${interaction.user} (${interaction.user.tag})`, inline: false },
        { name: "🎮 ชื่อ Roblox",    value: robloxName,  inline: true },
        { name: "📛 ชื่อเล่น/อายุ", value: nicknameAge, inline: true },
        { name: "🪪 ชื่อ IC",        value: icName,      inline: false },
        { name: "⏰ เวลาว่าง",       value: freeTime,    inline: true },
        { name: "🖥️ อุปกรณ์",       value: device,      inline: true },
        { name: "🏅 ยศหลัก",    value: roleStatus,  inline: false }
      )
      .setFooter({ text: `เซิร์ฟเวอร์: ${guildName} • สมัครเมื่อ` })
      .setTimestamp();

    // Embed ย่อ (ห้องสำรอง — แสดงเฉพาะ 3 ฟิลด์ ไม่มีลำดับ)
    const backupEmbed = new EmbedBuilder()
      .setColor(0x0066ff)
      .setTitle("📋 ข้อมูลสมาชิก")
      .addFields(
        { name: "🎮 ชื่อ Roblox",    value: robloxName,  inline: true },
        { name: "📛 ชื่อเล่น/อายุ", value: nicknameAge, inline: true },
        { name: "👤 Discord",        value: `${interaction.user}`, inline: false }
      )
      .setFooter({ text: `เซิร์ฟเวอร์: ${guildName} • สมัครเมื่อ` })
      .setTimestamp();

    // ── 3. ส่งไป MEMBER_LOG_ID (ห้องหลัก — ครบทุกฟิลด์ + ปุ่ม) ──
    let mainMsgId    = null;
    let backupMsgId  = null;

    if (MEMBER_LOG_ID) {
      try {
        const ch  = await client.channels.fetch(MEMBER_LOG_ID);
        const msg = await ch.send({
          embeds: [memberEmbed],
          components: [buildMemberAdminButtons(userId)],
        });
        mainMsgId = msg.id;
        console.log(`📤 ส่ง Embed ไป MEMBER_LOG_ID สำเร็จ (msg: ${mainMsgId})`);
      } catch (err) {
        console.error(`❌ ส่งไป MEMBER_LOG_ID ไม่ได้: ${err.message}`);
      }
    } else {
      console.warn("⚠️  MEMBER_LOG_ID ไม่ได้ตั้งค่า");
    }

    // ── 4. ส่งไป ADMIN_BACKUP_ID (ห้องสำรอง — 3 ฟิลด์ ไม่มีปุ่ม) ──
    if (ADMIN_BACKUP_ID) {
      try {
        const ch  = await client.channels.fetch(ADMIN_BACKUP_ID);
        const msg = await ch.send({ embeds: [backupEmbed] });
        backupMsgId = msg.id;
        console.log(`📤 ส่ง Embed ไป ADMIN_BACKUP_ID สำเร็จ (msg: ${backupMsgId})`);
      } catch (err) {
        console.error(`❌ ส่งไป ADMIN_BACKUP_ID ไม่ได้: ${err.message}`);
      }
    } else {
      console.warn("⚠️  ADMIN_BACKUP_ID ไม่ได้ตั้งค่า");
    }

    // ── 5. เก็บ messageId ทั้งคู่ไว้สำหรับ sync ตอนยึดยศ ──
    memberMessages.set(userId, { mainMsgId, backupMsgId });

    // ── 6. ยืนยันกลับผู้ใช้ ──
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x0066ff)
          .setTitle("✅ บันทึกข้อมูลเรียบร้อยแล้ว!")
          .setDescription(roleAdded
            ? "ยินดีต้อนรับสู่ ✗iCNIE กรอกข้อมูลสำเร็จ และ ส่งให้แอดมินเรียบร้อยครับ 🎉"
            : "บันทึกข้อมูลแล้ว แต่ยังมอบยศไม่ได้ — กรุณาแจ้งแอดมินครับ"
          )
          .setTimestamp(),
      ],
    });
  }

  // ─────────────────────────────────────────
  // Button: แอดมินกด "รับรู้แล้ว" สมาชิก (ห้องหลัก)
  // ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("member_ack_")) {
    await interaction.deferUpdate();
    await markMessageDone(interaction.message, interaction.user, "✅ รับรู้แล้ว");
    console.log(`✅ รับรู้แล้ว — แอดมิน ${interaction.user.tag}`);
  }

  // ─────────────────────────────────────────
  // Button: แอดมินกด "อนุมัติ" ใบลา
  // ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("leave_approve_")) {
    await interaction.deferUpdate();
    const requesterId = interaction.customId.replace("leave_approve_", "");

    await sendDM(requesterId, new EmbedBuilder()
      .setColor(0x0066ff)
      .setTitle("✅ ใบลาของคุณได้รับการอนุมัติแล้ว")
      .setDescription("ทีมงานได้อนุมัติคำขอลาของคุณเรียบร้อยแล้ว 😊")
      .setFooter({ text: `อนุมัติโดย: ${interaction.user.tag}` })
      .setTimestamp()
    );

    await markMessageDone(interaction.message, interaction.user, "✅ อนุมัติใบลาแล้ว");
  }

  // ─────────────────────────────────────────
  // Button: แอดมินกด "ปฏิเสธ" ใบลา → Modal
  // ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("leave_reject_")) {
    const requesterId = interaction.customId.replace("leave_reject_", "");
    const messageId   = interaction.message.id;

    const modal = new ModalBuilder()
      .setCustomId(`reject_modal_${requesterId}_${messageId}`)
      .setTitle("กรอกสาเหตุที่ปฏิเสธ");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reject_reason").setLabel("สาเหตุที่ปฏิเสธ")
          .setStyle(TextInputStyle.Paragraph).setPlaceholder("กรอกเหตุผลที่ไม่อนุมัติใบลา...")
          .setRequired(true).setMaxLength(500)
      )
    );

    await interaction.showModal(modal);
  }

  // ─────────────────────────────────────────
  // Button: แอดมินกด "ยึดยศคืน" → Modal กรอกสาเหตุ
  // ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("member_revoke_")) {
    const targetUserId = interaction.customId.replace("member_revoke_", "");
    const messageId    = interaction.message.id;

    const modal = new ModalBuilder()
      .setCustomId(`revoke_modal_${targetUserId}_${messageId}`)
      .setTitle("กรอกสาเหตุที่ยึดยศคืน");

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("revoke_reason").setLabel("สาเหตุที่ไม่อนุมัติ / ยึดยศคืน")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("เช่น ข้อมูลไม่ถูกต้อง, ชื่อ Roblox ไม่ตรง...")
          .setRequired(true).setMaxLength(500)
      )
    );

    await interaction.showModal(modal);
  }

  // ─────────────────────────────────────────
  // Modal Submit: ยึดยศคืน → ถอนยศ + DM + อัปเดตสีเทาทั้ง 2 ห้อง
  // ─────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("revoke_modal_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts        = interaction.customId.split("_");
    const messageId    = parts[parts.length - 1];
    const targetUserId = parts[parts.length - 2];
    const revokeReason = interaction.fields.getTextInputValue("revoke_reason");

    // ── ถอนยศ ──
    let revoked = false;
    try {
      const targetMember = await interaction.guild.members.fetch(targetUserId);
      await targetMember.roles.remove(MEMBER_ROLE_ID);
      revoked = true;
      console.log(`🚫 ยึดยศจาก ${targetUserId} โดย ${interaction.user.tag} | เหตุ: ${revokeReason}`);
    } catch (err) {
      console.error(`❌ ยึดยศไม่สำเร็จ: ${err.message}`);
    }

    // ── DM แจ้งสมาชิก ──
    await sendDM(targetUserId, new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("❌ ยศสมาชิกของคุณถูกยึดคืนแล้ว")
      .setDescription(`คุณถูกยึดยศคืนเนื่องจาก:\n**${revokeReason}**`)
      .addFields({ name: "📋 สาเหตุ", value: revokeReason, inline: false })
      .setFooter({ text: `ดำเนินการโดย: ${interaction.user.tag}` })
      .setTimestamp()
    );

    // ── อัปเดต Embed ทั้ง 2 ห้องพร้อมกัน ──
    // หาว่าข้อความที่ถูกกดมาจากห้องไหน แล้ว fallback ด้วย stored IDs
    const stored = memberMessages.get(targetUserId);

    // กำหนด mainMsgId / backupMsgId โดย cross-check กับ messageId ที่กดมา
    const mainMsgId   = stored?.mainMsgId   ?? (messageId);
    const backupMsgId = stored?.backupMsgId ?? null;

    // อัปเดตห้องหลัก
    await revokeUpdateEmbed(MEMBER_LOG_ID,   mainMsgId,   revokeReason, interaction.user);
    // อัปเดตห้องสำรอง
    await revokeUpdateEmbed(ADMIN_BACKUP_ID, backupMsgId, revokeReason, interaction.user);

    // ล้าง Map หลังจัดการแล้ว
    memberMessages.delete(targetUserId);

    await interaction.editReply({
      content: revoked
        ? `✅ ยึดยศคืนจาก <@${targetUserId}> ส่ง DM แจ้งเหตุผล และอัปเดตสถานะทั้ง 2 ห้องแล้วครับ`
        : `⚠️ ส่ง DM แล้ว แต่ถอนยศไม่สำเร็จ (สมาชิกอาจออกจาก Server แล้ว)`,
    });
  }

  // ─────────────────────────────────────────
  // Modal Submit: สาเหตุปฏิเสธใบลา
  // ─────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("reject_modal_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts        = interaction.customId.split("_");
    const messageId    = parts[parts.length - 1];
    const requesterId  = parts[parts.length - 2];
    const rejectReason = interaction.fields.getTextInputValue("reject_reason");

    await sendDM(requesterId, new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("❌ ใบลาของคุณไม่ได้รับการอนุมัติ")
      .setDescription("ขออภัยครับ ทีมงานไม่สามารถอนุมัติคำขอลาของคุณในครั้งนี้ได้")
      .addFields({ name: "📋 เหตุผล", value: rejectReason, inline: false })
      .setFooter({ text: `ปฏิเสธโดย: ${interaction.user.tag}` })
      .setTimestamp()
    );

    try {
      const leaveChannel = await client.channels.fetch(LEAVE_LOG_ID);
      const adminMessage = await leaveChannel.messages.fetch(messageId);
      await markMessageDone(adminMessage, interaction.user, "❌ ปฏิเสธใบลาแล้ว");
    } catch (err) {
      console.error("ไม่สามารถแก้ข้อความแอดมินได้:", err);
    }

    await interaction.editReply({ content: "✅ ส่งผลการปฏิเสธทาง DM แล้วครับ" });
  }
});

// ========== Login ==========
client.login(TOKEN);
