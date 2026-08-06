--!nonstrict
--[[
	BuddyService
	The equipped creature that follows the player around.

	There are no creature models in this project (see docs/ADDING_CONTENT.md for
	how to plug your own in), so a buddy is rendered as a glowing orb in its
	rarity colour with a nameplate. The orb is welded rather than scripted to
	follow: a weld replicates for free, while a per-frame position update would
	cost server CPU proportional to player count and still look worse.
]]

local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)
local Format = require(Shared.Format)
local RollEngine = require(Shared.RollEngine)
local Config = require(Shared.Config)

local BuddyService = {}

local ctx
local BUDDY_NAME = "PokeRNGBuddy"

function BuddyService.init(dependencies)
	ctx = dependencies
end

local function toColor(rgb: { number }): Color3
	return Color3.fromRGB(rgb[1], rgb[2], rgb[3])
end

local function destroyBuddy(character: Model?)
	if not character then
		return
	end
	local existing = character:FindFirstChild(BUDDY_NAME)
	if existing then
		existing:Destroy()
	end
end

local function build(character: Model, speciesId: number, variantKey: string)
	local root = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not root then
		return
	end

	local species = Species.byId[speciesId]
	if not species then
		return
	end

	local tier = Rarity.get(species.tier)
	local rarity = RollEngine.speciesRarity(speciesId, Config.Luck.Base) * RollEngine.variantRarityMult(variantKey)

	local orb = Instance.new("Part")
	orb.Name = BUDDY_NAME
	orb.Shape = Enum.PartType.Ball
	orb.Size = Vector3.new(1.4, 1.4, 1.4)
	orb.Material = Enum.Material.Neon
	orb.Color = toColor(tier.color)
	orb.CanCollide = false
	orb.CanQuery = false
	orb.CanTouch = false
	orb.Massless = true
	orb.CastShadow = false

	-- Variants recolour the orb so a shiny buddy reads at a glance.
	local variants = RollEngine.variantsFromKey(variantKey)
	if #variants > 0 then
		local variant = RollEngine.variantByKey(variants[#variants])
		if variant then
			orb.Color = toColor(variant.color)
		end
	end

	local light = Instance.new("PointLight")
	light.Color = orb.Color
	light.Range = 10
	light.Brightness = 2
	light.Parent = orb

	local billboard = Instance.new("BillboardGui")
	billboard.Name = "Nameplate"
	billboard.Size = UDim2.fromOffset(220, 52)
	billboard.StudsOffsetWorldSpace = Vector3.new(0, 1.6, 0)
	billboard.AlwaysOnTop = false
	billboard.MaxDistance = 80
	billboard.Parent = orb

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Size = UDim2.new(1, 0, 0.6, 0)
	title.Font = Enum.Font.GothamBold
	title.TextScaled = true
	title.TextColor3 = toColor(tier.glow)
	title.TextStrokeTransparency = 0.4
	local prefix = RollEngine.variantDisplayName(variantKey)
	title.Text = prefix ~= "" and `{prefix} {species.name}` or species.name
	title.Parent = billboard

	local subtitle = Instance.new("TextLabel")
	subtitle.BackgroundTransparency = 1
	subtitle.Position = UDim2.new(0, 0, 0.6, 0)
	subtitle.Size = UDim2.new(1, 0, 0.4, 0)
	subtitle.Font = Enum.Font.Gotham
	subtitle.TextScaled = true
	subtitle.TextColor3 = Color3.fromRGB(230, 230, 240)
	subtitle.TextStrokeTransparency = 0.6
	subtitle.Text = Format.rarity(rarity)
	subtitle.Parent = billboard

	orb.Parent = character

	local weld = Instance.new("Weld")
	weld.Part0 = root
	weld.Part1 = orb
	weld.C0 = CFrame.new(2.5, 2.6, 1)
	weld.Parent = orb

	-- Gentle bob, so the orb reads as alive rather than stuck to the player.
	local tween = TweenService:Create(
		weld,
		TweenInfo.new(1.6, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true),
		{ C0 = CFrame.new(2.5, 3.2, 1) }
	)
	tween:Play()
end

--[[
	Rebuild the buddy from whatever the profile currently says.
]]
function BuddyService.refresh(player: Player)
	local character = player.Character
	if not character then
		return
	end

	destroyBuddy(character)

	local profile = ctx.dataService.get(player)
	if not profile or not profile.buddy then
		return
	end

	build(character, profile.buddy.speciesId, profile.buddy.variantKey or "")
end

function BuddyService.start()
	local function hook(player: Player)
		player.CharacterAdded:Connect(function(character)
			-- Wait for the rig to finish assembling before welding to it.
			character:WaitForChild("HumanoidRootPart", 10)
			task.wait(0.2)
			BuddyService.refresh(player)
		end)

		if player.Character then
			BuddyService.refresh(player)
		end
	end

	Players.PlayerAdded:Connect(hook)
	for _, player in Players:GetPlayers() do
		hook(player)
	end

	ctx.dataService.Loaded:Connect(function(player)
		BuddyService.refresh(player)
	end)
end

return BuddyService
