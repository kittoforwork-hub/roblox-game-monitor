-- Place this Script in ServerScriptService (server-side only).
-- Create a Roblox Secret named "RobloxMonitorToken" with the same value as
-- the Cloudflare Worker secret ROBLOX_INGEST_TOKEN. Never put the token in a LocalScript.
-- Secret domain: set the Secret's domain to your Worker host only (for example
-- roblox-game-monitor.<account>.workers.dev), not "*". Secrets go in headers, never in the body.
-- Enable: Experience Settings > Security > Allow HTTP Requests.
-- Privacy: this sends Roblox user IDs to an external server. Tell players in your experience's
-- privacy disclosure, keep SEND_USERNAME off unless you need it, and never send data about
-- players you are not permitted to track under Roblox policies or local privacy law.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local ENDPOINT = "https://roblox-game-monitor.kitto-for-work.workers.dev/api/roblox/player-events"
local AUTHORIZATION = HttpService:GetSecret("RobloxMonitorToken"):AddPrefix("Bearer ")
local SERVER_JOB_ID = game.JobId ~= "" and game.JobId or ("studio-" .. HttpService:GenerateGUID(false))
local FLUSH_INTERVAL_SECONDS = 5
local MAX_BATCH_SIZE = 25
local MAX_QUEUE_SIZE = 2000 -- drop the oldest events if the endpoint stays down
local SEND_USERNAME = false -- data minimisation: user IDs are enough for session counts
local MAX_RETRIES = 5
local RETRY_BASE_SECONDS = 2

local queue = {}
local queuedPlayers = {}
local flushing = false

local function queuePlayerEvent(eventType, player)
    local userId = tostring(player.UserId)
    local eventId = HttpService:GenerateGUID(false)
    table.insert(queue, {
        eventId = eventId,
        eventType = eventType,
        placeId = tostring(game.PlaceId),
        universeId = tostring(game.GameId),
        jobId = SERVER_JOB_ID,
        userId = userId,
        username = SEND_USERNAME and player.Name or nil,
        occurredAt = DateTime.now().UnixTimestampMillis,
    })
    while #queue > MAX_QUEUE_SIZE do
        table.remove(queue, 1)
    end
end

local function sendBatch(batch, retryLimit)
    retryLimit = retryLimit or MAX_RETRIES
    local requestBody = HttpService:JSONEncode({ events = batch })
    for attempt = 1, retryLimit do
        local ok, response = pcall(function()
            return HttpService:RequestAsync({
                Url = ENDPOINT,
                Method = "POST",
                Headers = {
                    ["Content-Type"] = "application/json",
                    ["Authorization"] = AUTHORIZATION,
                },
                Body = requestBody,
            })
        end)

        if ok and response and response.Success then
            return true
        end

        local statusCode = ok and response and response.StatusCode or 0
        -- A 4xx (other than 408/429) means the batch itself is rejected; retrying would block
        -- every later event, so drop it and keep the queue moving.
        if statusCode >= 400 and statusCode < 500 and statusCode ~= 408 and statusCode ~= 429 then
            warn(string.format("[PlayerTelemetry] Batch rejected with status %d; dropping %d events", statusCode, #batch))
            return true
        end
        warn(string.format("[PlayerTelemetry] Send failed (attempt %d/%d, status %s)", attempt, retryLimit, tostring(statusCode)))
        if attempt < retryLimit then
            task.wait(math.min(RETRY_BASE_SECONDS * (2 ^ (attempt - 1)), 30))
        end
    end
    return false
end

local function flushQueue(retryLimit)
    if flushing then
        return
    end
    flushing = true

    while #queue > 0 do
        local batchSize = math.min(#queue, MAX_BATCH_SIZE)
        local batch = {}
        for index = 1, batchSize do
            batch[index] = queue[index]
        end

        if sendBatch(batch, retryLimit) then
            for _ = 1, batchSize do
                table.remove(queue, 1)
            end
        else
            -- Keep events for the next periodic attempt rather than silently losing them.
            break
        end
    end

    flushing = false
end

local function onPlayerAdded(player)
    if queuedPlayers[player.UserId] then
        return
    end
    queuedPlayers[player.UserId] = true
    queuePlayerEvent("join", player)
end

local function onPlayerRemoving(player)
    queuePlayerEvent("leave", player)
    queuedPlayers[player.UserId] = nil
    -- Try to send promptly on leave; periodic flush remains the fallback.
    task.spawn(flushQueue)
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

-- Handle players already present if this Script starts late.
for _, player in ipairs(Players:GetPlayers()) do
    onPlayerAdded(player)
end

task.spawn(function()
    while true do
        task.wait(FLUSH_INTERVAL_SECONDS)
        flushQueue()
    end
end)

game:BindToClose(function()
    -- Roblox gives shutdown callbacks a limited window. Do a best-effort final flush.
    local deadline = os.clock() + 20
    while #queue > 0 and os.clock() < deadline do
        flushQueue(2)
        if #queue > 0 then
            task.wait(1)
        end
    end
end)
