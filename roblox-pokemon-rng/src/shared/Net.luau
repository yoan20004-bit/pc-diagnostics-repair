--!nonstrict
--[[
	Net
	Remote plumbing. The server creates the remotes on boot; the client waits for
	them. Every name used by either side is declared here so a typo is a nil
	index at startup rather than a silently dead button.

	Direction is documented, not enforced -- but note that nothing the client
	sends is trusted. Payloads are intents ("I want to buy luckCharm"), never
	outcomes ("give me 5000 coins").
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Net = {}

Net.FolderName = "PokeRNGRemotes"

-- Server -> client
Net.ToClient = {
	-- Full profile snapshot. Sent on join and after anything that changes it.
	StateSync = "StateSync",
	-- One roll outcome, for the reveal animation.
	RollResult = "RollResult",
	-- Toast message: { text, kind }
	Notify = "Notify",
	-- Server-wide rare roll broadcast.
	Announce = "Announce",
	-- Top-25 payload from the OrderedDataStores.
	LeaderboardSync = "LeaderboardSync",
}

-- Client -> server
Net.ToServer = {
	RequestRoll = "RequestRoll",
	SetAutoRoll = "SetAutoRoll",
	EquipBuddy = "EquipBuddy",
	SellDuplicates = "SellDuplicates",
	BuyUpgrade = "BuyUpgrade",
	BuyPotion = "BuyPotion",
	Prestige = "Prestige",
	UpdateSetting = "UpdateSetting",
	ClaimDaily = "ClaimDaily",
	RedeemCode = "RedeemCode",
	PromptPurchase = "PromptPurchase",
}

local function ensureFolder(): Folder
	local existing = ReplicatedStorage:FindFirstChild(Net.FolderName)
	if existing then
		return existing :: Folder
	end

	assert(RunService:IsServer(), "the client must not create the remote folder")
	local folder = Instance.new("Folder")
	folder.Name = Net.FolderName
	folder.Parent = ReplicatedStorage
	return folder
end

--[[
	Creates every remote. Server only, called once during boot.
]]
function Net.build(): { [string]: RemoteEvent }
	assert(RunService:IsServer(), "Net.build is server only")

	local folder = ensureFolder()
	local remotes = {}

	local function make(name: string)
		local existing = folder:FindFirstChild(name)
		if existing then
			remotes[name] = existing
			return
		end
		local remote = Instance.new("RemoteEvent")
		remote.Name = name
		remote.Parent = folder
		remotes[name] = remote
	end

	for _, name in Net.ToClient do
		make(name)
	end
	for _, name in Net.ToServer do
		make(name)
	end

	return remotes
end

--[[
	Client-side accessor. Yields until the server has finished building.
]]
function Net.get(name: string): RemoteEvent
	local folder = ReplicatedStorage:WaitForChild(Net.FolderName, 30)
	assert(folder, "remote folder never appeared -- is the server script running?")
	local remote = folder:WaitForChild(name, 30)
	assert(remote, `remote "{name}" never appeared`)
	return remote :: RemoteEvent
end

return Net
