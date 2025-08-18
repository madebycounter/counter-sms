function formatPhone(phone) {
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length === 10) {
        return `+1${cleaned}`;
    }
    if (cleaned.length === 11 && cleaned.startsWith("1")) {
        return `+${cleaned}`;
    }
    return null;
}

function useApiKey(req, res, next) {
    const authHeader = req.headers.authorization;
    const apiKey =
        authHeader && authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;
    const validApiKeys = process.env.API_KEYS
        ? process.env.API_KEYS.split(",")
        : [];

    if (!apiKey || !validApiKeys.includes(apiKey)) {
        return res
            .status(401)
            .json({ status: "error", message: "Unauthorized" });
    }

    next();
}

async function addMessage(prisma, senderPhone, recipientPhone, content) {
    let sender = await prisma.user.findUnique({
        where: { phoneNumber: senderPhone },
    });

    if (!sender) {
        sender = await prisma.user.create({
            data: {
                phoneNumber: senderPhone,
                active: false,
            },
        });
    }

    let recipient = await prisma.user.findUnique({
        where: { phoneNumber: recipientPhone },
    });

    if (!recipient) {
        recipient = await prisma.user.create({
            data: {
                phoneNumber: recipientPhone,
                active: false,
            },
        });
    }

    const message = await prisma.message.create({
        data: {
            content: content,
            senderId: sender.id,
            receiverId: recipient.id,
        },
    });

    return message;
}

module.exports = { formatPhone, useApiKey, addMessage };
