const { App } = require("@slack/bolt");
const { PrismaClient } = require("@prisma/client");
const { MessagingResponse } = require("twilio").twiml;
const { formatPhone, useApiKey, addMessage } = require("./util.js");
const express = require("express");
const twilioClient = require("twilio");

require("dotenv").config();

const app = express();

const prisma = new PrismaClient({
    log: ["query", "info", "warn", "error"],
});

const slack = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

const twilio = twilioClient(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function sendSubscribeMessage(to) {
    const msg = {
        body: "You have subscribed to event notifications from /counter. Notifications will end automatically once the event is over, or reply STOP to unsubscribe.\n\nVisit https://madebycounter.com/live to check out past, current, and future streams.",
        from: process.env.TWILIO_SEND_NUMBER,
        to: to,
    };

    await addMessage(prisma, msg.from, msg.to, msg.body);

    return await twilio.messages.create(msg);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/subscribe", useApiKey, async (req, res) => {
    const phone = formatPhone(req.body.phone);

    if (!phone) {
        return res
            .status(400)
            .json({ status: "error", message: "Invalid US phone number" });
    }

    try {
        const user = await prisma.user.upsert({
            where: { phoneNumber: phone },
            update: { active: true },
            create: { phoneNumber: phone, active: true },
        });

        await sendSubscribeMessage(phone);

        res.json({ status: "ok", message: user });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message,
        });
    }
});

app.get("/users", useApiKey, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                phoneNumber: true,
                active: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        res.json({ status: "ok", users });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: "Failed to get users",
        });
    }
});

app.post("/send", useApiKey, async (req, res) => {
    const { message } = req.body;
    const isProduction = req.headers["x-production"] === "true";

    if (!message) {
        return res.status(400).json({
            status: "error",
            message: "Message body is required",
        });
    }

    try {
        let users;

        if (isProduction) {
            users = await prisma.user.findMany({
                select: {
                    id: true,
                    phoneNumber: true,
                    active: true,
                    createdAt: true,
                    updatedAt: true,
                },
                where: {
                    active: true,
                },
            });
        } else {
            users = [
                {
                    phoneNumber: "+14087977416",
                },
            ];
        }

        for (const user of users) {
            const msg = {
                body: (isProduction ? "" : "[TEST MODE] ") + message,
                from: process.env.TWILIO_SEND_NUMBER,
                to: user.phoneNumber,
            };

            await addMessage(prisma, msg.from, msg.to, msg.body);
            await twilio.messages.create(msg);
        }

        res.json({
            status: "ok",
            message: `Message sent to ${users.length} users`,
            production: isProduction,
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: error.message,
        });
    }
});

app.get("/messages", useApiKey, async (req, res) => {
    try {
        const messages = await prisma.message.findMany({
            include: {
                sender: {
                    select: {
                        id: true,
                        phoneNumber: true,
                        active: true,
                    },
                },
                receiver: {
                    select: {
                        id: true,
                        phoneNumber: true,
                        active: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        res.json({ status: "ok", messages });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: "Failed to get messages",
        });
    }
});

app.get("/messages/:phone", useApiKey, async (req, res) => {
    const phone = req.params.phone.trim();

    try {
        const user = await prisma.user.findUnique({
            where: { phoneNumber: phone },
        });

        const twilioUser = await prisma.user.findUnique({
            where: { phoneNumber: process.env.TWILIO_SEND_NUMBER },
        });

        if (!user || !twilioUser) {
            return res.status(404).json({
                status: "error",
                message: "User not found",
            });
        }

        const messages = await prisma.message.findMany({
            where: {
                OR: [
                    { senderId: user.id, receiverId: twilioUser.id },
                    { senderId: twilioUser.id, receiverId: user.id },
                ],
            },
            include: {
                sender: {
                    select: {
                        id: true,
                        phoneNumber: true,
                        active: true,
                    },
                },
                receiver: {
                    select: {
                        id: true,
                        phoneNumber: true,
                        active: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        res.json({ status: "ok", messages });
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: "Failed to get messages for conversation",
        });
    }
});

app.post("/inbound", async (req, res) => {
    const messageBody = req.body.Body;
    const from = req.body.From;
    const to = req.body.To;

    try {
        let user = await prisma.user.findUnique({
            where: { phoneNumber: from },
        });

        const msgLower = messageBody.toLowerCase().trim();

        const hasSubscribe =
            msgLower == process.env.SUBSCRIBE_KEYWORD.toLowerCase();

        const hasUnsubscribe =
            msgLower == process.env.UNSUBSCRIBE_KEYWORD.toLowerCase();

        const hasNetworkSubscribe =
            messageBody == "unstop" || messageBody == "start";

        if (!user) {
            user = await prisma.user.create({
                data: {
                    phoneNumber: from,
                    active: hasSubscribe || hasNetworkSubscribe,
                },
            });
        } else {
            if (hasSubscribe || hasNetworkSubscribe) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { active: true },
                });

                await sendSubscribeMessage(from);
            }

            if (hasUnsubscribe) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { active: false },
                });
            }
        }

        await addMessage(prisma, from, to, messageBody);

        console.log(`SMS from ${from} to ${to}: ${messageBody}`);
        res.status(200).send();
    } catch (error) {
        console.error("Error processing inbound message:", error);
        res.status(200).send();
    }
});

slack.message(async ({ message, say }) => {
    if (message.subtype || message.bot_id) return;

    if (message.channel === process.env.SLACK_CHANNEL_ID) {
        const originalText = message.text || "(no text provided)";

        await say({
            text: "Do you want to send this message?",
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `📩 *Confirm send?*\n\n"${originalText}"`,
                    },
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: { type: "plain_text", text: "✅ SEND" },
                            style: "primary",
                            value: JSON.stringify({
                                ts: message.ts,
                                text: originalText,
                                user: message.user,
                            }),
                            action_id: "send_message",
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "❌ CANCEL" },
                            style: "danger",
                            value: JSON.stringify({
                                ts: message.ts,
                                user: message.user,
                            }),
                            action_id: "cancel_message",
                        },
                    ],
                },
            ],
        });
    }
});

slack.action("send_message", async ({ body, ack, client }) => {
    await ack();

    const { ts, text } = JSON.parse(body.actions[0].value);
    const channel = process.env.SLACK_CHANNEL_ID;

    await client.chat.delete({
        channel,
        ts: body.message.ts,
    });

    await sendMessage(
        text
            .replace(/<([^|>]+)(?:\|[^>]+)?>/g, "$1")
            .replaceAll("&gt;", ">")
            .replaceAll("&lt;", "<")
    );

    await client.reactions.add({
        channel,
        timestamp: ts,
        name: "white_check_mark",
    });
});

slack.action("cancel_message", async ({ body, ack, client }) => {
    await ack();

    const { ts } = JSON.parse(body.actions[0].value);
    const channel = process.env.SLACK_CHANNEL_ID;

    await client.chat.delete({
        channel,
        ts: body.message.ts,
    });

    await client.reactions.add({
        channel,
        timestamp: ts,
        name: "no_entry_sign",
    });
});

async function sendMessage(text) {
    const users = await prisma.user.findMany({
        select: {
            id: true,
            phoneNumber: true,
            active: true,
            createdAt: true,
            updatedAt: true,
        },
        where: {
            active: true,
        },
    });

    for (const user of users) {
        const msg = {
            body: text,
            from: process.env.TWILIO_SEND_NUMBER,
            to: user.phoneNumber,
        };

        await addMessage(prisma, msg.from, msg.to, msg.body);
        await twilio.messages.create(msg);
    }
}

process.on("SIGTERM", async () => {
    await prisma.$disconnect();
    process.exit(0);
});

process.on("SIGINT", async () => {
    await prisma.$disconnect();
    process.exit(0);
});

(async () => {
    try {
        await slack.start();
        await prisma.$connect();

        app.listen(3000, () => {
            console.log(`Express server running on port ${3000}`);
        });
    } catch (error) {
        console.error("Failed to start application:", error);
        await prisma.$disconnect();
        process.exit(1);
    }
})();
