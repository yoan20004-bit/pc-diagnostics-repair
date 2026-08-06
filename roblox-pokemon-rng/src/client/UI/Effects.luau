--!nonstrict
--[[
	Effects
	The reveal. Everything here is cosmetic -- the roll already happened on the
	server and the result is already in the player's inventory by the time any
	of this runs, so an effect that fails or is skipped costs nothing.

	Three intensities, chosen by tier:
	  * quiet   -- the card slides in and out, no fuss (Common..Epic)
	  * shake   -- plus a camera kick and a burst of particles (Mythic)
	  * cinematic -- plus a screen dim and a slower, longer card (Legendary+)

	Players who roll thousands of times want the common case to be fast and the
	rare case to feel like an event, and they want to be able to turn the whole
	thing off. Both are honoured here.
]]

local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local Workspace = game:GetService("Workspace")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Format = require(Shared.Format)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local State = require(script.Parent.Parent.State)

local Effects = {}

local card
local cardTitle
local cardSubtitle
local cardRarity
local cardBadge
local cardStroke
local cardGlow
local dimmer

local activeToken = 0

function Effects.build(parent: Instance)
	dimmer = Create("Frame", {
		Name = "Dimmer",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = Color3.new(0, 0, 0),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Visible = false,
		ZIndex = 28,
		Parent = parent,
	})

	card = Create("Frame", {
		Name = "RevealCard",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.38),
		Size = UDim2.fromOffset(420, 132),
		BackgroundColor3 = Theme.color.panel,
		BorderSizePixel = 0,
		Visible = false,
		ZIndex = 30,
		Parent = parent,
	})
	Theme.corner(14).Parent = card
	cardStroke = Theme.stroke(Theme.color.accent, 2.5)
	cardStroke.Parent = card

	cardGlow = Create("UIGradient", {
		Color = ColorSequence.new(Theme.color.panel, Theme.color.panelAlt),
		Rotation = 90,
		Parent = card,
	})

	cardBadge = Theme.label({
		Text = "NEW",
		Font = Theme.font.heading,
		TextSize = 12,
		TextColor3 = Theme.color.backdrop,
		TextXAlignment = Enum.TextXAlignment.Center,
		BackgroundColor3 = Theme.color.warning,
		BackgroundTransparency = 0,
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -12, 0, 10),
		Size = UDim2.fromOffset(52, 20),
		Visible = false,
		ZIndex = 32,
		Parent = card,
		Theme.corner(6),
	})

	cardTitle = Theme.label({
		Text = "",
		Font = Theme.font.heading,
		TextSize = 26,
		TextXAlignment = Enum.TextXAlignment.Center,
		Position = UDim2.fromOffset(0, 18),
		Size = UDim2.new(1, 0, 0, 32),
		ZIndex = 31,
		Parent = card,
	})

	cardSubtitle = Theme.label({
		Text = "",
		TextSize = 14,
		TextColor3 = Theme.color.subtext,
		TextXAlignment = Enum.TextXAlignment.Center,
		Position = UDim2.fromOffset(0, 52),
		Size = UDim2.new(1, 0, 0, 20),
		ZIndex = 31,
		Parent = card,
	})

	cardRarity = Theme.label({
		Text = "",
		Font = Theme.font.heading,
		TextSize = 20,
		TextXAlignment = Enum.TextXAlignment.Center,
		Position = UDim2.fromOffset(0, 80),
		Size = UDim2.new(1, 0, 0, 28),
		ZIndex = 31,
		Parent = card,
	})
end

--[[
	A short, decaying camera kick. Runs on RenderStepped and composes with
	whatever the camera is already doing rather than taking it over.
]]
function Effects.shake(intensity: number, duration: number)
	local camera = Workspace.CurrentCamera
	if not camera then
		return
	end

	local elapsed = 0
	local connection
	connection = RunService.RenderStepped:Connect(function(dt)
		elapsed += dt
		if elapsed >= duration then
			connection:Disconnect()
			return
		end

		local falloff = 1 - (elapsed / duration)
		local magnitude = intensity * falloff * falloff
		camera.CFrame = camera.CFrame
			* CFrame.new(
				(math.random() - 0.5) * magnitude,
				(math.random() - 0.5) * magnitude,
				(math.random() - 0.5) * magnitude * 0.4
			)
	end)
end

local function findAltar(): BasePart?
	local world = Workspace:FindFirstChild("PokeRNGWorld")
	if not world then
		return nil
	end
	for _, child in world:GetChildren() do
		if child:IsA("BasePart") and child:GetAttribute("PokeRNGAltar") then
			return child
		end
	end
	return nil
end

--[[
	Pulse the world altar in the tier colour. Purely ambient -- other players
	standing nearby see their own client's version of this for their own rolls.
]]
function Effects.pulseAltar(color: Color3, strength: number)
	local altar = findAltar()
	if not altar then
		return
	end

	local baseSize = Vector3.new(6, 6, 6)
	altar.Color = color

	TweenService:Create(
		altar,
		TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
		{ Size = baseSize * (1 + 0.25 * strength) }
	):Play()

	task.delay(0.14, function()
		TweenService:Create(altar, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
			Size = baseSize,
		}):Play()
	end)
end

local function burst(parent: Instance, color: Color3, count: number)
	for i = 1, count do
		local shard = Create("Frame", {
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.fromScale(0.5, 0.5),
			Size = UDim2.fromOffset(6, 6),
			BackgroundColor3 = color,
			BorderSizePixel = 0,
			Rotation = math.random(0, 360),
			ZIndex = 29,
			Parent = parent,
		})
		Theme.corner(3).Parent = shard

		local angle = (i / count) * math.pi * 2 + math.random() * 0.4
		local distance = 140 + math.random() * 160
		local target = UDim2.new(0.5, math.cos(angle) * distance, 0.5, math.sin(angle) * distance)

		local info = TweenInfo.new(0.55 + math.random() * 0.3, Enum.EasingStyle.Quint, Enum.EasingDirection.Out)
		TweenService:Create(shard, info, {
			Position = target,
			BackgroundTransparency = 1,
			Size = UDim2.fromOffset(2, 2),
			Rotation = shard.Rotation + math.random(-180, 180),
		}):Play()

		task.delay(1, function()
			shard:Destroy()
		end)
	end
end

--[[
	Show a roll. `result` is the RollResult payload straight off the remote.
]]
function Effects.reveal(result: any)
	if not card then
		return
	end

	local settings = State.current and State.current.settings
	local lowEffects = settings and settings.lowEffects
	local cinematicsOn = not settings or settings.cinematics ~= false

	local species = Species.byId[result.speciesId]
	if not species then
		return
	end

	local tierColor = Theme.rarityColor(result.tier)
	local glow = Theme.rarityGlow(result.tier)

	local variantName = RollEngine.variantDisplayName(result.variantKey or "")
	local title = variantName ~= "" and `{variantName} {result.name}` or result.name

	local isCinematic = cinematicsOn
		and not lowEffects
		and result.tierIndex >= Config.Effects.CinematicTierIndex
	local isShake = not lowEffects and result.tierIndex >= Config.Effects.ShakeTierIndex

	activeToken += 1
	local token = activeToken

	cardTitle.Text = title
	cardTitle.TextColor3 = glow
	cardSubtitle.Text = `{string.upper(result.tier)}  ·  {table.concat(species.types, " / ")}`
	cardSubtitle.TextColor3 = tierColor
	cardRarity.Text = Format.rarity(result.effectiveRarity)
	cardRarity.TextColor3 = Theme.color.text
	cardStroke.Color = tierColor
	cardGlow.Color = ColorSequence.new(tierColor:Lerp(Theme.color.panel, 0.78), Theme.color.panel)

	if result.newSpecies then
		cardBadge.Text = "NEW"
		cardBadge.BackgroundColor3 = Theme.color.warning
		cardBadge.Visible = true
	elseif result.newVariant then
		cardBadge.Text = "NEW FORM"
		cardBadge.BackgroundColor3 = Theme.color.accent
		cardBadge.Visible = true
	elseif result.isRecord then
		cardBadge.Text = "RECORD"
		cardBadge.BackgroundColor3 = Theme.color.success
		cardBadge.Visible = true
	else
		cardBadge.Visible = false
	end

	card.Visible = true
	card.Size = UDim2.fromOffset(360, 118)
	card.BackgroundTransparency = 0

	local holdTime = isCinematic and 2.6 or (isShake and 1.4 or 0.85)

	TweenService:Create(card, TweenInfo.new(0.22, Enum.EasingStyle.Back, Enum.EasingDirection.Out), {
		Size = UDim2.fromOffset(isCinematic and 520 or 420, isCinematic and 160 or 132),
	}):Play()

	if isCinematic then
		dimmer.Visible = true
		TweenService:Create(dimmer, TweenInfo.new(0.2), { BackgroundTransparency = 0.45 }):Play()
		burst(card.Parent, glow, 26)
		Effects.shake(1.6, 0.7)
		Effects.pulseAltar(tierColor, 2)
	elseif isShake then
		burst(card.Parent, glow, 12)
		Effects.shake(0.5, 0.35)
		Effects.pulseAltar(tierColor, 1)
	elseif not lowEffects then
		Effects.pulseAltar(tierColor, 0.35)
	end

	task.delay(holdTime, function()
		-- A newer roll already took over the card; leave it alone.
		if token ~= activeToken then
			return
		end

		TweenService:Create(card, TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {
			Size = UDim2.fromOffset(360, 110),
			BackgroundTransparency = 1,
		}):Play()

		if dimmer.Visible then
			local fade = TweenService:Create(dimmer, TweenInfo.new(0.25), { BackgroundTransparency = 1 })
			fade.Completed:Connect(function()
				if token == activeToken then
					dimmer.Visible = false
				end
			end)
			fade:Play()
		end

		task.delay(0.2, function()
			if token == activeToken then
				card.Visible = false
			end
		end)
	end)
end

return Effects
