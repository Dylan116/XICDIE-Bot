require("dotenv").config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("ตั้งค่าระบบแจ้งลาด่วน — ส่ง Embed พร้อมปุ่มแจ้งลา")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("setup2")
    .setDescription("ตั้งค่าระบบกรอกข้อมูลสมาชิกใหม่ — ส่ง Embed พร้อมปุ่มกรอกข้อมูล")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetcounter")
    .setDescription("รีเซ็ตลำดับสมาชิกกลับเป็น 0 (แอดมินเท่านั้น)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("📡 กำลัง deploy Slash Commands...");

    let data;
    if (GUILD_ID) {
      data = await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Deploy สำเร็จ ${data.length} คำสั่ง (Guild: ${GUILD_ID})`);
    } else {
      data = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(`✅ Deploy สำเร็จ ${data.length} คำสั่ง (Global — รอ ~1 ชม. เพื่อให้มีผล)`);
    }
  } catch (error) {
    console.error("❌ Deploy ล้มเหลว:", error);
  }
})();
