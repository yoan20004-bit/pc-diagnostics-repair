--!nonstrict
--[[
	WorldBuilder
	Builds the map at runtime: a plaza, the roll altar, and two physical
	leaderboard pillars.

	Generating the map in code rather than shipping a .rbxl means the whole game
	lives in version control as readable text -- you can diff a change to the
	map the same way you diff a change to the roll table. If you would rather
	build the map by hand in Studio, delete the WorldBuilder call in
	init.server.luau and nothing else changes.

	Everything is parented under a single folder and guarded by a marker, so
	running twice (or running alongside a hand-built map) will not duplicate it.
]]

local Lighting = game:GetService("Lighting")
local Workspace = game:GetService("Workspace")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)
local Format = require(Shared.Format)
local RollEngine = require(Shared.RollEngine)

local WorldBuilder = {}

local FOLDER_NAME = "PokeRNGWorld"
local boards: { [string]: SurfaceGui } = {}

local function toColor(rgb: { number }): Color3
	return Color3.fromRGB(rgb[1], rgb[2], rgb[3])
end

local function part(props: { [string]: any }, parent: Instance): BasePart
	local instance = Instance.new("Part")
	instance.Anchored = true
	instance.Material = Enum.Material.SmoothPlastic
	for key, value in props do
		instance[key] = value
	end
	instance.Parent = parent
	return instance
end

local function configureLighting()
	Lighting.Ambient = Color3.fromRGB(70, 70, 90)
	Lighting.OutdoorAmbient = Color3.fromRGB(95, 100, 125)
	Lighting.Brightness = 2
	Lighting.ClockTime = 18.5
	Lighting.GeographicLatitude = 20
	Lighting.EnvironmentDiffuseScale = 0.4
	Lighting.EnvironmentSpecularScale = 0.4

	if not Lighting:FindFirstChildOfClass("Atmosphere") then
		local atmosphere = Instance.new("Atmosphere")
		atmosphere.Density = 0.32
		atmosphere.Offset = 0.2
		atmosphere.Color = Color3.fromRGB(200, 205, 230)
		atmosphere.Decay = Color3.fromRGB(96, 92, 130)
		atmosphere.Glare = 0.2
		atmosphere.Haze = 1.4
		atmosphere.Parent = Lighting
	end

	if not Lighting:FindFirstChildOfClass("Bloom") then
		local bloom = Instance.new("BloomEffect")
		bloom.Intensity = 0.7
		bloom.Size = 28
		bloom.Threshold = 0.9
		bloom.Parent = Lighting
	end

	if not Lighting:FindFirstChildOfClass("ColorCorrectionEffect") then
		local correction = Instance.new("ColorCorrectionEffect")
		correction.Saturation = 0.12
		correction.Contrast = 0.08
		correction.Parent = Lighting
	end
end

local function buildPlaza(folder: Folder)
	part({
		Name = "Ground",
		Size = Vector3.new(240, 4, 240),
		Position = Vector3.new(0, -2, 0),
		Color = Color3.fromRGB(46, 52, 68),
		Material = Enum.Material.Slate,
	}, folder)

	local plaza = part({
		Name = "Plaza",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(1.5, 90, 90),
		CFrame = CFrame.new(0, 0.5, 0) * CFrame.Angles(0, 0, math.rad(90)),
		Color = Color3.fromRGB(70, 78, 100),
		Material = Enum.Material.Marble,
	}, folder)
	plaza.TopSurface = Enum.SurfaceType.Smooth

	-- A ring of tier-coloured pillars, rarest at the back. Doubles as a legend
	-- for the rarity ladder.
	local count = #Rarity.tiers
	for i, tier in Rarity.tiers do
		local angle = (i / count) * math.pi * 2
		local radius = 38
		local position = Vector3.new(math.cos(angle) * radius, 6, math.sin(angle) * radius)

		local pillar = part({
			Name = `Pillar_{tier.id}`,
			Size = Vector3.new(3, 12, 3),
			Position = position,
			Color = toColor(tier.color),
			Material = Enum.Material.Neon,
			Transparency = 0.25,
		}, folder)

		local light = Instance.new("PointLight")
		light.Color = toColor(tier.glow)
		light.Range = 22
		light.Brightness = 1.6
		light.Parent = pillar

		local label = Instance.new("BillboardGui")
		label.Size = UDim2.fromOffset(190, 60)
		label.StudsOffset = Vector3.new(0, 8, 0)
		label.MaxDistance = 140
		label.Parent = pillar

		local name = Instance.new("TextLabel")
		name.BackgroundTransparency = 1
		name.Size = UDim2.new(1, 0, 0.6, 0)
		name.Font = Enum.Font.GothamBold
		name.TextScaled = true
		name.TextColor3 = toColor(tier.glow)
		name.TextStrokeTransparency = 0.5
		name.Text = tier.name
		name.Parent = label

		local odds = Instance.new("TextLabel")
		odds.BackgroundTransparency = 1
		odds.Position = UDim2.new(0, 0, 0.6, 0)
		odds.Size = UDim2.new(1, 0, 0.4, 0)
		odds.Font = Enum.Font.Gotham
		odds.TextScaled = true
		odds.TextColor3 = Color3.fromRGB(220, 224, 236)
		odds.TextStrokeTransparency = 0.6
		odds.Text = tier.index == 1 and "the rest" or Format.rarity(tier.rarity)
		odds.Parent = label
	end
end

local function buildAltar(folder: Folder)
	local base = part({
		Name = "Altar",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(2, 18, 18),
		CFrame = CFrame.new(0, 1.5, 0) * CFrame.Angles(0, 0, math.rad(90)),
		Color = Color3.fromRGB(28, 32, 46),
		Material = Enum.Material.Metal,
	}, folder)
	base.Name = "AltarBase"

	local core = part({
		Name = "AltarCore",
		Shape = Enum.PartType.Ball,
		Size = Vector3.new(6, 6, 6),
		Position = Vector3.new(0, 7, 0),
		Color = Color3.fromRGB(120, 190, 255),
		Material = Enum.Material.Neon,
		Transparency = 0.15,
		CanCollide = false,
	}, folder)

	local light = Instance.new("PointLight")
	light.Color = Color3.fromRGB(150, 200, 255)
	light.Range = 40
	light.Brightness = 3
	light.Parent = core

	-- The client tags this part to spin it and pulse it on a roll, so it needs a
	-- stable, findable name.
	core:SetAttribute("PokeRNGAltar", true)

	local prompt = Instance.new("BillboardGui")
	prompt.Size = UDim2.fromOffset(280, 70)
	prompt.StudsOffset = Vector3.new(0, 5, 0)
	prompt.MaxDistance = 120
	prompt.Parent = core

	local text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Size = UDim2.fromScale(1, 1)
	text.Font = Enum.Font.GothamBold
	text.TextScaled = true
	text.TextColor3 = Color3.fromRGB(235, 242, 255)
	text.TextStrokeTransparency = 0.45
	text.Text = "The Wild Grass"
	text.Parent = prompt
end

local function buildBoard(folder: Folder, id: string, title: string, position: Vector3, facing: number): SurfaceGui
	local pillar = part({
		Name = `Board_{id}`,
		Size = Vector3.new(24, 18, 1.5),
		CFrame = CFrame.new(position) * CFrame.Angles(0, math.rad(facing), 0),
		Color = Color3.fromRGB(24, 27, 38),
		Material = Enum.Material.Metal,
	}, folder)

	local surface = Instance.new("SurfaceGui")
	surface.Name = "Board"
	surface.Face = Enum.NormalId.Front
	surface.CanvasSize = Vector2.new(600, 450)
	surface.LightInfluence = 0
	surface.Parent = pillar

	local background = Instance.new("Frame")
	background.Size = UDim2.fromScale(1, 1)
	background.BackgroundColor3 = Color3.fromRGB(16, 18, 26)
	background.BorderSizePixel = 0
	background.Parent = surface

	local heading = Instance.new("TextLabel")
	heading.Size = UDim2.new(1, 0, 0, 52)
	heading.BackgroundColor3 = Color3.fromRGB(30, 34, 48)
	heading.BorderSizePixel = 0
	heading.Font = Enum.Font.GothamBold
	heading.TextScaled = true
	heading.TextColor3 = Color3.fromRGB(240, 244, 255)
	heading.Text = title
	heading.Parent = background

	local list = Instance.new("Frame")
	list.Name = "List"
	list.Position = UDim2.new(0, 8, 0, 58)
	list.Size = UDim2.new(1, -16, 1, -66)
	list.BackgroundTransparency = 1
	list.Parent = background

	local layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 3)
	layout.Parent = list

	boards[id] = surface
	return surface
end

--[[
	Redraw a physical board from a leaderboard payload.
]]
function WorldBuilder.updateBoards(data: any)
	local rarest = boards.rarest
	if rarest then
		local list = rarest:FindFirstChild("Frame") and rarest.Frame:FindFirstChild("List")
		if list then
			for _, child in list:GetChildren() do
				if child:IsA("TextLabel") then
					child:Destroy()
				end
			end

			for _, row in data.rarest do
				local species = row.speciesId and Species.byId[row.speciesId]
				local label = Instance.new("TextLabel")
				label.LayoutOrder = row.rank
				label.Size = UDim2.new(1, 0, 0, 26)
				label.BackgroundTransparency = 1
				label.Font = Enum.Font.Gotham
				label.TextXAlignment = Enum.TextXAlignment.Left
				label.TextScaled = true
				label.TextColor3 = species and toColor(Rarity.get(species.tier).glow) or Color3.fromRGB(220, 220, 230)

				local prefix = RollEngine.variantDisplayName(row.variantKey or "")
				local creature = species and species.name or "?"
				if prefix ~= "" then
					creature = `{prefix} {creature}`
				end
				label.Text = `{row.rank}. {row.name} - {creature} ({Format.rarity(row.rarity)})`
				label.Parent = list
			end
		end
	end

	local rolls = boards.rolls
	if rolls then
		local list = rolls:FindFirstChild("Frame") and rolls.Frame:FindFirstChild("List")
		if list then
			for _, child in list:GetChildren() do
				if child:IsA("TextLabel") then
					child:Destroy()
				end
			end

			for _, row in data.rolls do
				local label = Instance.new("TextLabel")
				label.LayoutOrder = row.rank
				label.Size = UDim2.new(1, 0, 0, 26)
				label.BackgroundTransparency = 1
				label.Font = Enum.Font.Gotham
				label.TextXAlignment = Enum.TextXAlignment.Left
				label.TextScaled = true
				label.TextColor3 = Color3.fromRGB(220, 224, 236)
				label.Text = `{row.rank}. User {row.userId} - {Format.comma(row.rolls)} rolls`
				label.Parent = list
			end
		end
	end
end

function WorldBuilder.build()
	local existing = Workspace:FindFirstChild(FOLDER_NAME)
	if existing then
		return existing
	end

	local folder = Instance.new("Folder")
	folder.Name = FOLDER_NAME
	folder.Parent = Workspace

	configureLighting()
	buildPlaza(folder)
	buildAltar(folder)
	buildBoard(folder, "rarest", "RAREST FINDS", Vector3.new(-26, 9, -46), 20)
	buildBoard(folder, "rolls", "MOST ROLLS", Vector3.new(26, 9, -46), -20)

	local spawnLocation = Instance.new("SpawnLocation")
	spawnLocation.Name = "PokeRNGSpawn"
	spawnLocation.Anchored = true
	spawnLocation.CanCollide = true
	spawnLocation.Size = Vector3.new(12, 1, 12)
	spawnLocation.Position = Vector3.new(0, 3, 26)
	spawnLocation.Color = Color3.fromRGB(90, 160, 255)
	spawnLocation.Material = Enum.Material.Neon
	spawnLocation.Transparency = 0.4
	spawnLocation.Duration = 0
	spawnLocation.Parent = folder

	return folder
end

return WorldBuilder
